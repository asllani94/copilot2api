import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { fakeClient, parseSse, parseSseEvents, replyWith, testConfig } from "./helpers.js";

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

  it("GET /models is an alias for /v1/models", async () => {
    const app = createApp(fakeClient(), testConfig());
    const res = await app.request("/models");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).object, "list");
  });

  it("does not add configured aliases to the model list", async () => {
    const app = createApp(
      fakeClient({ models: [{ id: "auto" }] }),
      testConfig({ modelMap: { "claude-sonnet-4": "auto" } }),
    );
    const body = await (await app.request("/v1/models")).json();
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["auto"],
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

  it("accepts the key via x-api-key (Anthropic style)", async () => {
    const res = await app.request("/v1/models", { headers: { "x-api-key": "secret" } });
    assert.equal(res.status, 200);
  });

  it("guards alias routes too", async () => {
    const res = await app.request("/models");
    assert.equal(res.status, 401);
  });

  it("shapes the 401 like an Anthropic error on /v1/messages", async () => {
    const res = await app.request("/v1/messages", jsonPost({ model: "auto", messages: [] }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "authentication_error");
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
    // The SDK's default system message (host cwd, git root) is always replaced.
    assert.deepEqual(session.config.systemMessage, {
      mode: "replace",
      content: "You are a helpful assistant.",
    });
    assert.equal(session.disconnected, true);
    assert.equal(session.lastPrompt, "hi");
  });

  it("hoists system messages into the replaced system message", async () => {
    const client = fakeClient({ script: replyWith("ok") });
    const app = createApp(client, testConfig());
    await app.request(
      "/v1/chat/completions",
      jsonPost({
        model: "auto",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const [session] = client.sessions;
    assert.equal(session.config.systemMessage.content, "Be terse.");
    assert.equal(session.lastPrompt, "hi");
  });

  it("resolves configured model aliases but echoes the requested id", async () => {
    const client = fakeClient({ script: replyWith("ok") });
    const app = createApp(client, testConfig({ modelMap: { "claude-sonnet-4": "auto" } }));
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(client.sessions[0].config.model, "auto");
    assert.equal((await res.json()).model, "claude-sonnet-4");
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

describe("chat completions tool calling", () => {
  const tools = [
    {
      type: "function",
      function: { name: "click", description: "Click", parameters: { type: "object" } },
    },
  ];
  const toolReply = 'On it. [tool_call]{"name":"click","arguments":{"s":"#go"}}[/tool_call]';

  it("describes tools in the system message", async () => {
    const client = fakeClient({ script: replyWith("ok") });
    const app = createApp(client, testConfig());
    await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", tools, messages: [{ role: "user", content: "go" }] }),
    );
    assert.match(client.sessions[0].config.systemMessage.content, /# Tool calling protocol/);
  });

  it("parses protocol blocks into tool_calls (non-streaming)", async () => {
    const client = fakeClient({ script: replyWith(toolReply) });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", tools, messages: [{ role: "user", content: "go" }] }),
    );
    const choice = (await res.json()).choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, "On it. ");
    const [call] = choice.message.tool_calls;
    assert.equal(call.function.name, "click");
    assert.deepEqual(JSON.parse(call.function.arguments), { s: "#go" });
  });

  it("streams tool_calls deltas and finishes with tool_calls", async () => {
    // Split mid-marker to exercise the parser's chunk reassembly.
    const client = fakeClient({
      script: (s) => {
        s.emit("assistant.message_delta", { deltaContent: toolReply.slice(0, 15) });
        s.emit("assistant.message_delta", { deltaContent: toolReply.slice(15) });
        s.emit("session.idle");
      },
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/chat/completions",
      jsonPost({ model: "auto", stream: true, tools, messages: [{ role: "user", content: "go" }] }),
    );
    const events = parseSse(await res.text());
    assert.equal(events.at(-1), "[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
    const [call] = toolChunk.choices[0].delta.tool_calls;
    assert.equal(call.function.name, "click");
    assert.deepEqual(JSON.parse(call.function.arguments), { s: "#go" });
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    assert.equal(text, "On it. ");
  });
});

describe("POST /v1/messages", () => {
  it("returns an Anthropic message for a plain reply", async () => {
    const client = fakeClient({ script: replyWith("pong") });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/messages",
      jsonPost({ model: "auto", max_tokens: 64, messages: [{ role: "user", content: "ping" }] }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "message");
    assert.deepEqual(body.content, [{ type: "text", text: "pong" }]);
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(client.sessions[0].lastPrompt, "ping");
  });

  it("translates Anthropic tools and returns tool_use blocks", async () => {
    const client = fakeClient({
      script: replyWith('[tool_call]{"name":"click","arguments":{"s":"#go"}}[/tool_call]'),
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/messages",
      jsonPost({
        model: "auto",
        max_tokens: 64,
        tools: [{ name: "click", description: "Click", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "click go" }],
      }),
    );
    const body = await res.json();
    assert.equal(body.stop_reason, "tool_use");
    const toolUse = body.content.find((b) => b.type === "tool_use");
    assert.equal(toolUse.name, "click");
    assert.deepEqual(toolUse.input, { s: "#go" });
    assert.match(client.sessions[0].config.systemMessage.content, /# Tool calling protocol/);
  });

  it("streams the Anthropic event sequence", async () => {
    const client = fakeClient({
      script: (s) => {
        s.emit("assistant.message_delta", { deltaContent: "po" });
        s.emit("assistant.message_delta", { deltaContent: "ng" });
        s.emit("session.idle");
      },
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/messages",
      jsonPost({
        model: "auto",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      }),
    );
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const events = parseSseEvents(await res.text());
    assert.deepEqual(
      events.map((e) => e.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    assert.equal(text, "pong");
    assert.equal(client.sessions[0].disconnected, true);
  });

  it("emits an Anthropic error event on session failure", async () => {
    const client = fakeClient({ script: (s) => s.emit("session.error", { message: "boom" }) });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/messages",
      jsonPost({ model: "auto", max_tokens: 64, stream: true, messages: [{ role: "user", content: "x" }] }),
    );
    const events = parseSseEvents(await res.text());
    const error = events.find((e) => e.event === "error");
    assert.equal(error.data.error.type, "api_error");
    assert.equal(error.data.error.message, "boom");
  });

  it("shapes validation errors like Anthropic errors", async () => {
    const app = createApp(fakeClient(), testConfig());
    const res = await app.request("/v1/messages", jsonPost({ model: "auto", messages: [] }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
  });

  it("counts tokens with the size heuristic", async () => {
    const app = createApp(fakeClient(), testConfig());
    const res = await app.request(
      "/v1/messages/count_tokens",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "x".repeat(400) }] }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.input_tokens >= 100);
  });
});

describe("POST /chat/completions alias", () => {
  it("behaves like /v1/chat/completions", async () => {
    const client = fakeClient({ script: replyWith("pong") });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/chat/completions",
      jsonPost({ model: "auto", messages: [{ role: "user", content: "ping" }] }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "pong");
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
