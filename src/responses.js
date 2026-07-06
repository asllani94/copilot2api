/**
 * Translation between the OpenAI Responses API wire format and the
 * Copilot SDK's plain-text prompt/session model.
 *
 * Copilot sessions are text-only for this bridge, so structured features
 * are prompt-shimmed:
 * - `text.format` (json_schema/json_object) becomes an output directive and
 *   the reply is reduced to its JSON payload.
 * - `tools` become a protocol directive: the model answers with a
 *   `{"tool_call": ...}` JSON object, which is translated back into a
 *   `function_call` output item.
 */
import crypto from "node:crypto";
import { ApiError } from "./errors.js";

const TOOL_CALL_DIRECTIVE = `To call a tool, reply with ONLY a JSON object (no prose, no code fences) of the form:
{"tool_call": {"name": "<tool name>", "arguments": { ... }}}
Call at most one tool per reply. If no tool call is needed, reply normally.`;

/** Parse a Responses API request body into a prompt plus bridging metadata. */
export function parseResponsesRequest(body) {
  const { model, input, instructions, text, tools } = body;
  if (!model) throw new ApiError(400, "'model' is required");
  if (input === undefined) throw new ApiError(400, "'input' is required");
  if (body.stream) {
    throw new ApiError(400, "Streaming is not supported on /v1/responses yet; use stream: false");
  }

  const functionTools = (tools ?? []).filter((t) => t.type === "function");
  const jsonFormat =
    text?.format?.type === "json_schema" || text?.format?.type === "json_object"
      ? text.format
      : null;

  const sections = [];
  const system = [instructions, ...collectSystemTexts(input)].filter(Boolean).join("\n");
  if (system) sections.push(`<instructions>\n${system}\n</instructions>`);

  if (functionTools.length > 0) {
    const toolList = functionTools
      .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
      .join("\n");
    sections.push(`<tools>\nYou can call these tools:\n${toolList}\n\n${TOOL_CALL_DIRECTIVE}\n</tools>`);
  }

  if (jsonFormat) {
    const schema = jsonFormat.type === "json_schema" ? JSON.stringify(jsonFormat.schema) : null;
    sections.push(
      schema
        ? `<output-format>\nReply with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${schema}\n</output-format>`
        : "<output-format>\nReply with ONLY a JSON object (no prose, no code fences).\n</output-format>",
    );
  }

  sections.push(renderInput(input));

  return {
    model,
    prompt: sections.join("\n\n"),
    hasTools: functionTools.length > 0,
    toolNames: new Set(functionTools.map((t) => t.name)),
    jsonOnly: Boolean(jsonFormat),
  };
}

function collectSystemTexts(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item.role === "system" || item.role === "developer")
    .map((item) => itemText(item.content));
}

function renderInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) throw new ApiError(400, "'input' must be a string or an array");

  const lines = [];
  for (const item of input) {
    if (item.role === "system" || item.role === "developer") continue; // hoisted into <instructions>
    if (item.type === "function_call") {
      lines.push(`Assistant: {"tool_call": {"name": ${JSON.stringify(item.name)}, "arguments": ${item.arguments || "{}"}}}`);
    } else if (item.type === "function_call_output") {
      lines.push(`Tool result for ${item.call_id}: ${itemText(item.output)}`);
    } else if (item.role === "user" || item.role === "assistant") {
      lines.push(`${item.role === "user" ? "User" : "Assistant"}: ${itemText(item.content)}`);
    }
  }
  if (lines.length === 1 && lines[0].startsWith("User: ")) {
    return lines[0].slice("User: ".length);
  }
  return `The following is a conversation transcript. Reply with the next assistant message only, without any role prefix.\n\n${lines.join("\n\n")}`;
}

function itemText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/** Extract the first JSON object from a reply, tolerating code fences and prose. */
export function extractJsonObject(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : reply).trim();
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  // Walk to the matching closing brace of the first object.
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Build the Responses API response body from the model's plain-text reply. */
export function toResponse(request, reply) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const output = [];

  const parsed = extractJsonObject(reply);
  const toolCall = request.hasTools ? parsed?.tool_call : null;
  if (toolCall && request.toolNames.has(toolCall.name)) {
    output.push({
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
      status: "completed",
    });
  } else {
    // For JSON-mode replies, reduce prose/fences to the JSON payload.
    const text = request.jsonOnly && parsed ? JSON.stringify(parsed) : reply;
    output.push({
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  return {
    id: `resp_${id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: request.model,
    output,
    // The SDK does not report token counts.
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    incomplete_details: null,
    error: null,
  };
}
