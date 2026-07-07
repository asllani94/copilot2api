/**
 * Translation between the Anthropic Messages API wire format and the
 * Copilot SDK's system/prompt session model.
 *
 * Requests are rendered the same way as chat completions (system message +
 * transcript prompt); tool use rides on the shared [tool_call] text protocol
 * from toolcalls.js and is translated back into `tool_use` content blocks
 * and Anthropic SSE events.
 */
import crypto from "node:crypto";
import { ApiError } from "./errors.js";
import { renderTranscript } from "./openai.js";
import { toolCallBlock, toolInstructions } from "./toolcalls.js";

/** Parse an Anthropic Messages request into session bridging metadata. */
export function parseMessagesRequest(body) {
  const { model, messages, system, tools, stream = false } = body;
  if (!model) throw new ApiError(400, "'model' is required");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "'messages' must be a non-empty array");
  }

  // Anthropic tools carry `input_schema`; server tool types without one
  // (computer use, bash, ...) cannot be bridged and are ignored.
  const functionTools = (tools ?? [])
    .filter((t) => t?.name && t.input_schema)
    .map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));

  const systemParts = [blocksToText(system)].filter(Boolean);
  if (functionTools.length > 0) systemParts.push(toolInstructions(functionTools));

  const lines = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(...renderUserMessage(m.content));
    else if (m.role === "assistant") lines.push(renderAssistantMessage(m.content));
  }

  return {
    model,
    stream: Boolean(stream),
    system: systemParts.join("\n\n"),
    prompt: renderTranscript(lines),
  };
}

/** A user message may interleave text and tool_result blocks. */
function renderUserMessage(content) {
  if (typeof content === "string") return [`User: ${content}`];
  if (!Array.isArray(content)) return [];

  const lines = [];
  const textParts = [];
  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_result") {
      lines.push(`Tool result (${block.tool_use_id}): ${blocksToText(block.content)}`);
    }
  }
  if (textParts.length > 0) lines.push(`User: ${textParts.join("\n")}`);
  return lines;
}

function renderAssistantMessage(content) {
  let line = "Assistant:";
  const text = blocksToText(content);
  if (text) line += ` ${text}`;
  if (Array.isArray(content)) {
    const calls = content
      .filter((block) => block.type === "tool_use")
      .map((block) => toolCallBlock(block.name, block.input));
    if (calls.length > 0) line += `\n${calls.join("\n")}`;
  }
  return line;
}

/** Flatten Anthropic content (string or block array) to its text. */
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function messageId() {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Non-streaming Messages response body.
 * @param {{text: string, toolCalls: Array<{id: string, name: string, arguments: string}>}} reply
 */
export function toMessagesResponse(model, { text, toolCalls }) {
  const content = [];
  if (text || toolCalls.length === 0) content.push({ type: "text", text });
  for (const tc of toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.arguments) });
  }
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    // The SDK does not report token counts.
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function parseArgs(argsJson) {
  try {
    const parsed = JSON.parse(argsJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * State machine producing the Anthropic SSE event sequence
 * (message_start, content_block_* per block, message_delta, message_stop)
 * from text deltas and parsed tool calls. Each method returns the
 * `{event, data}` pairs to write.
 */
export class MessagesStream {
  #model;
  #blockIndex = -1;
  #textOpen = false;

  constructor(model) {
    this.#model = model;
  }

  start() {
    return [
      event("message_start", {
        type: "message_start",
        message: {
          id: messageId(),
          type: "message",
          role: "assistant",
          model: this.#model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }

  text(delta) {
    const events = [];
    if (!this.#textOpen) {
      this.#blockIndex++;
      this.#textOpen = true;
      events.push(
        event("content_block_start", {
          type: "content_block_start",
          index: this.#blockIndex,
          content_block: { type: "text", text: "" },
        }),
      );
    }
    events.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: this.#blockIndex,
        delta: { type: "text_delta", text: delta },
      }),
    );
    return events;
  }

  toolCall(id, name, argsJson) {
    const events = this.#closeTextBlock();
    this.#blockIndex++;
    const index = this.#blockIndex;
    events.push(
      event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name, input: {} },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: argsJson },
      }),
      event("content_block_stop", { type: "content_block_stop", index }),
    );
    return events;
  }

  finish(stopReason) {
    return [
      ...this.#closeTextBlock(),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      }),
      event("message_stop", { type: "message_stop" }),
    ];
  }

  #closeTextBlock() {
    if (!this.#textOpen) return [];
    this.#textOpen = false;
    return [event("content_block_stop", { type: "content_block_stop", index: this.#blockIndex })];
  }
}

function event(name, data) {
  return { event: name, data };
}

/**
 * `POST /v1/messages/count_tokens` response. The SDK exposes no tokenizer,
 * so this is the usual bytes/4 estimate over the request's model-visible
 * parts — precise enough for clients that only budget context.
 */
export function countTokens(body) {
  const { messages, system, tools } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "'messages' must be a non-empty array");
  }
  const size = JSON.stringify({ system, messages, tools }).length;
  return { input_tokens: Math.max(1, Math.round(size / 4)) };
}

/** Anthropic-shaped error envelope. */
export function toAnthropicError(message, type = "invalid_request_error") {
  // Map OpenAI-flavored internal types onto Anthropic's error vocabulary.
  const mapped = type === "server_error" ? "api_error" : type;
  return { type: "error", error: { type: mapped, message } };
}
