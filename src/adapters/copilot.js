/**
 * GitHub Copilot adapter (the default mode).
 *
 * Authentication: this adapter carries no credentials of its own. It wraps a
 * running `@github/copilot-sdk` client, which authenticates with your local
 * GitHub Copilot login (device flow, established via `copilot2api login`). The
 * token lives in the OS keychain and is managed entirely by the SDK/CLI — this
 * proxy never reads, stores, or forwards it.
 */

/**
 * The SDK's default system message describes the host process's environment
 * (cwd, directory listing, git root), which makes the model answer about the
 * proxy's own directory instead of the caller's context — so it is always
 * replaced.
 */
const DEFAULT_SYSTEM = "You are a helpful assistant.";

/**
 * Wrap a started CopilotClient in the common adapter interface.
 * @param {import("@github/copilot-sdk").CopilotClient} client
 */
export function copilotAdapter(client) {
  return {
    mode: "copilot",

    listModels() {
      return client.listModels();
    },

    /**
     * Create a chat-only session: no agent tools, any permission request is
     * rejected, and the caller's system message replaces the SDK's, so the SDK
     * behaves as a pure model endpoint.
     */
    createChatSession({ model, stream, system }) {
      return client.createSession({
        model,
        streaming: stream,
        availableTools: [],
        onPermissionRequest: () => ({ kind: "reject" }),
        systemMessage: { mode: "replace", content: system || DEFAULT_SYSTEM },
      });
    },

    async stop() {
      await client.stop?.();
    },
  };
}
