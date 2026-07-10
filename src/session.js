/**
 * Adapter-agnostic helpers for driving a chat session to completion.
 *
 * Every adapter (GitHub Copilot, M365 Copilot) returns a session object that
 * speaks the same small event interface:
 *
 *   session.on("assistant.message_delta", (e) => e.data.deltaContent)
 *   session.on("assistant.message",       (e) => e.data.content)
 *   session.on("session.idle",            () => {})
 *   session.on("session.error",           (e) => e.data.message)
 *   session.send({ prompt })          // stream; settles via events
 *   session.sendAndWait({ prompt })   // resolves when the turn ends
 *   session.abort() / session.disconnect()
 *
 * so the HTTP layer never needs to know which backend is in use.
 */
import { ApiError } from "./errors.js";

/**
 * Send a prompt and resolve with the final assistant message once the session
 * is idle. Rejects with an ApiError if the turn produced no content.
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
