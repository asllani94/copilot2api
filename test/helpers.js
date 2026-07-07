/**
 * Test doubles for the Copilot SDK, so the app can be exercised without a
 * live Copilot login.
 */

/**
 * A scripted stand-in for a CopilotSession. The `script` callback receives
 * the session and drives it by emitting events, simulating a model turn.
 */
export class FakeSession {
  #handlers = new Map();
  disconnected = false;
  aborted = false;
  lastPrompt = null;

  constructor(script, config) {
    this.script = script;
    this.config = config;
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(handler);
  }

  emit(event, data = {}) {
    for (const handler of this.#handlers.get(event) ?? []) handler({ data });
  }

  async send({ prompt }) {
    this.lastPrompt = prompt;
    queueMicrotask(() => this.script(this));
  }

  async sendAndWait({ prompt }) {
    this.lastPrompt = prompt;
    this.script(this);
  }

  async disconnect() {
    this.disconnected = true;
  }

  async abort() {
    this.aborted = true;
  }
}

/**
 * A stand-in for CopilotClient. `script` drives each created session;
 * created sessions are recorded on `.sessions` for assertions.
 */
export function fakeClient({ models = [{ id: "auto", name: "Auto" }], script = () => {} } = {}) {
  const sessions = [];
  return {
    sessions,
    async listModels() {
      return models;
    },
    async createSession(config) {
      const session = new FakeSession(script, config);
      sessions.push(session);
      return session;
    },
  };
}

/** A completed model turn that replies with `reply`. */
export function replyWith(reply) {
  return (session) => {
    session.emit("assistant.message_delta", { deltaContent: reply });
    session.emit("assistant.message", { content: reply });
    session.emit("session.idle");
  };
}

/** App config for tests: quiet logs, small body limit. */
export function testConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    apiKey: undefined,
    maxBodyBytes: 1024 * 1024,
    logRequests: false,
    ...overrides,
  };
}

/** Parse an SSE response body into its `data:` payloads. */
export function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length));
}

/** Parse a named-event SSE body (Anthropic style) into {event, data} pairs. */
export function parseSseEvents(text) {
  return text
    .split("\n\n")
    .filter((block) => block.includes("data: "))
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.*)$/m)[1]);
      return { event, data };
    });
}
