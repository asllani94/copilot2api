import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { fakeClient, parseSse, replyWith, testConfig } from "./helpers.js";

const jsonPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("health & models", () => {
  it("GET /health responds ok", async () => {
    const app = createApp(fakeClient(), testConfig());
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("GET /v1/models returns the OpenAI list shape", async () => {
    const app = createApp(fakeClient({ models: [{ id: "auto" }, { id: "gpt-5" }] }), testConfig());
    const res = await app.request("/v1/models");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["auto", "gpt-5"],
    );
  });
});

describe("authentication", () => {
  const app = createApp(fakeClient(), testConfig({ apiKey: "secret" }));

  it("rejects /v1 requests without a key", async () => {
    const res = await app.request("/v1/models");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, "authentication_error");
  });

  it("rejects a wrong key", async () => {
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  it("accepts the right key", async () => {
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer secret" } });
    assert.equal(res.status, 200);
  });

  it("leaves /health open", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
  });
});

describe("chat completions (non-streaming)", () => {
  it("returns the assistant reply", async () => {
    const client = fakeClient({ script: replyWith("pong") });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "ping" }] }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "pong");
    assert.equal(body.model, "auto");
  });

  it("creates a chat-only session and disconnects it", async () => {
    const client = fakeClient({ script: replyWith("ok") });
    const app = createApp(client, testConfig());
    await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    );
    const [session] = client.sessions;
    assert.deepEqual(session.config.availableTools, []);
    assert.deepEqual(session.config.onPermissionRequest(), { kind: "reject" });
    assert.equal(session.disconnected, true);
    assert.equal(session.lastPrompt, "hi");
  });

  it("maps a session error to 502", async () => {
    const client = fakeClient({
      script: (s) => {
        s.emit("session.error", { message: "model exploded" });
        s.emit("session.idle");
      },
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.type, "server_error");
    assert.match(body.error.message, /model exploded/);
  });
});

describe("chat completions (streaming)", () => {
  it("streams deltas as SSE chunks ending in [DONE]", async () => {
    const client = fakeClient({
      script: (s) => {
        s.emit("assistant.message_delta", { deltaContent: "po" });
        s.emit("assistant.message_delta", { deltaContent: "ng" });
        s.emit("session.idle");
      },
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", stream: true, messages: [{ role: "user", content: "ping" }] }),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const events = parseSse(await res.text());
    assert.equal(events.at(-1), "[DONE]");

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
    assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    assert.equal(text, "pong");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");

    assert.equal(client.sessions[0].disconnected, true);
  });

  it("emits an error event on session failure", async () => {
    const client = fakeClient({
      script: (s) => s.emit("session.error", { message: "boom" }),
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    const events = parseSse(await res.text());
    const error = events.map((e) => (e === "[DONE]" ? {} : JSON.parse(e))).find((e) => e.error);
    assert.equal(error.error.message, "boom");
    assert.notEqual(events.at(-1), "[DONE]");
  });
});

describe("request validation", () => {
  const app = createApp(fakeClient(), testConfig());

  it("rejects invalid JSON", async () => {
    const res = await app.request("/v1/chat/completions", jsonPost("not json"));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Invalid JSON/);
  });

  it("requires a model", async () => {
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /'model' is required/);
  });

  it("requires non-empty messages", async () => {
    const res = await app.request("/v1/chat/completions", jsonPost({ model: "auto", messages: [] }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /'messages'/);
  });

  it("rejects oversized bodies with 413", async () => {
    const smallLimit = createApp(fakeClient(), testConfig({ maxBodyBytes: 64 }));
    const res = await smallLimit.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "x".repeat(200) }] }),
    );
    assert.equal(res.status, 413);
  });

  it("404s unknown routes with an OpenAI-shaped error", async () => {
    const res = await app.request("/v1/nope?q=1");
    assert.equal(res.status, 404);
    assert.match((await res.json()).error.message, /Unknown route: GET \/v1\/nope/);
  });
});
