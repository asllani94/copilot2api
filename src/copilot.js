/**
 * Copilot SDK session helpers for the chat-completions bridge.
 */
import { ApiError } from "./errors.js";

/**
 * The SDK's default system message describes the host process's environment
 * (cwd, directory listing, git root), which makes the model answer about the
 * proxy's own directory instead of the caller's context — so it is always
 * replaced.
 */
const DEFAULT_SYSTEM = "You are a helpful assistant.";

/**
 * Create a chat-only session: no agent tools, any permission request is
 * rejected, and the caller's system message replaces the SDK's, so the SDK
 * behaves as a pure model endpoint.
 */
export function createChatSession(client, { model, stream, system }) {
  return client.createSession({
    model,
    streaming: stream,
    availableTools: [],
    onPermissionRequest: () => ({ kind: "reject" }),
    systemMessage: { mode: "replace", content: system || DEFAULT_SYSTEM },
  });
}

/**
 * Send a prompt and resolve with the final assistant message once the
 * session is idle. Rejects with an ApiError if the turn produced no content.
 */
export async function runToCompletion(session, prompt) {
  let content = "";
  let failure = null;
  session.on("assistant.message", (event) => {
    if (event.data.content) content = event.data.content;
  });
  session.on("session.error", (event) => {
    failure = event.data?.message ?? "Copilot session error";
  });

  try {
    await session.sendAndWait({ prompt });
  } catch (err) {
    failure = String(err?.message ?? err);
  } finally {
    await disconnectQuietly(session);
  }

  if (failure && !content) throw new ApiError(502, failure, "server_error");
  return content;
}

export function disconnectQuietly(session) {
  return session.disconnect().catch(() => {});
}
