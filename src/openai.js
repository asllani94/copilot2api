/**
 * Translation between the OpenAI Chat Completions wire format and the
 * Copilot SDK's prompt/session model.
 */
import crypto from "node:crypto";
import { toolCallBlock, toolInstructions } from "./toolcalls.js";

const MODEL_OWNER = "github-copilot";

/** Flatten OpenAI message content (string or content-part array) to plain text. */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/**
 * Render an OpenAI message array (plus optional function tools) into a
 * system message and a prompt for a Copilot session.
 *
 * SDK sessions are stateful, but OpenAI clients resend the full history on
 * every call — so each request gets a fresh session, the system/developer
 * messages (and tool protocol) become the session's system message, and the
 * conversation is rendered as one transcript prompt.
 *
 * @param {Array<object>} messages
 * @param {Array<{name: string, description?: string, parameters?: object}>} tools
 * @returns {{system: string, prompt: string}}
 */
export function renderChat(messages, tools = []) {
  const systemParts = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => contentToText(m.content))
    .filter(Boolean);
  if (tools.length > 0) systemParts.push(toolInstructions(tools));

  const lines = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`User: ${contentToText(m.content)}`);
    } else if (m.role === "assistant") {
      let line = "Assistant:";
      const text = contentToText(m.content);
      if (text) line += ` ${text}`;
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
        .filter((tc) => tc?.function?.name)
        .map((tc) => toolCallBlock(tc.function.name, tc.function.arguments));
      if (calls.length > 0) line += `\n${calls.join("\n")}`;
      lines.push(line);
    } else if (m.role === "tool") {
      const result = contentToText(m.content);
      lines.push(
        m.tool_call_id ? `Tool result (${m.tool_call_id}): ${result}` : `Tool result: ${result}`,
      );
    }
  }

  return { system: systemParts.join("\n\n"), prompt: renderTranscript(lines) };
}

/** Render transcript lines, collapsing a lone user turn to its raw text. */
export function renderTranscript(lines) {
  if (lines.length === 0) return "";
  if (lines.length === 1 && lines[0].startsWith("User: ")) {
    return lines[0].slice("User: ".length);
  }
  return `The following is a conversation transcript. Reply with the next assistant message only, without any role prefix.\n\n${lines.join("\n\n")}`;
}

/** Fresh identifiers for a completion response. */
export function completionMeta(model) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

/** `GET /v1/models` response body. */
export function toModelList(models) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: MODEL_OWNER,
    })),
  };
}

/**
 * Non-streaming `chat.completion` response body.
 * @param {{text: string, toolCalls?: Array<{id: string, name: string, arguments: string}>}} reply
 */
export function toChatCompletion(meta, { text, toolCalls = [] }) {
  const message = { role: "assistant", content: toolCalls.length > 0 && !text ? null : text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    ...meta,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    // The SDK does not report token counts.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Streaming delta carrying a single tool call, for use with `toChunk`. */
export function toolCallDelta(index, id, name, args) {
  return {
    tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
  };
}

/** Streaming `chat.completion.chunk` payload. */
export function toChunk(meta, delta, finishReason = null) {
  return {
    ...meta,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** OpenAI-shaped error body. */
export function toErrorBody(message, type = "invalid_request_error") {
  return { error: { message, type, param: null, code: null } };
}
