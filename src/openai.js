/**
 * Translation between the OpenAI Chat Completions wire format and the
 * Copilot SDK's prompt/session model.
 */
import crypto from "node:crypto";

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
 * Render an OpenAI message array into a single Copilot prompt.
 *
 * SDK sessions are stateful, but OpenAI clients resend the full history on
 * every call — so each request gets a fresh session and the history is
 * rendered as one transcript prompt.
 */
export function renderPrompt(messages) {
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => contentToText(m.content))
    .join("\n");
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");

  const parts = [];
  if (system) parts.push(`<instructions>\n${system}\n</instructions>`);

  if (turns.length === 1) {
    parts.push(contentToText(turns[0].content));
  } else {
    const transcript = turns
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${contentToText(m.content)}`)
      .join("\n\n");
    parts.push(
      "The following is a conversation transcript. Reply with the next assistant message only, without any role prefix.",
      transcript,
    );
  }
  return parts.join("\n\n");
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

/** Non-streaming `chat.completion` response body. */
export function toChatCompletion(meta, content) {
  return {
    ...meta,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    // The SDK does not report token counts.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
