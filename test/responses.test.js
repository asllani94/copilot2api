import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { extractJsonObject } from "../src/responses.js";
import { fakeClient, replyWith, testConfig } from "./helpers.js";

const jsonPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    assert.deepEqual(extractJsonObject('{"a": 1}'), { a: 1 });
  });

  it("parses JSON inside code fences", () => {
    assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"a": 1}\n```'), { a: 1 });
  });

  it("parses the first object embedded in prose", () => {
    assert.deepEqual(extractJsonObject('Sure! {"a": {"b": "}"}} trailing'), { a: { b: "}" } });
  });

  it("returns null when there is no JSON", () => {
    assert.equal(extractJsonObject("no json here"), null);
  });
});

describe("POST /v1/responses", () => {
  it("returns an output_text message for a plain reply", async () => {
    const client = fakeClient({ script: replyWith("pong") });
    const app = createApp(client, testConfig());
    const res = await app.request("/v1/responses", jsonPost({ model: "auto", input: "ping" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.deepEqual(body.output[0].content, [{ type: "output_text", text: "pong", annotations: [] }]);
    assert.equal(client.sessions[0].lastPrompt, "ping");
  });

  it("hoists instructions and renders message items", async () => {
    const client = fakeClient({ script: replyWith("ok") });
    const app = createApp(client, testConfig());
    await app.request(
      "/v1/responses",
      jsonPost({
        model: "auto",
        instructions: "Be terse.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
          { role: "user", content: [{ type: "input_text", text: "bye" }] },
        ],
      }),
    );
    const prompt = client.sessions[0].lastPrompt;
    assert.match(prompt, /<instructions>\nBe terse\.\n<\/instructions>/);
    assert.match(prompt, /User: hi/);
    assert.match(prompt, /Assistant: hello/);
    assert.match(prompt, /User: bye/);
  });

  it("reduces a JSON-mode reply to its JSON payload", async () => {
    const client = fakeClient({
      script: replyWith('Here is the result:\n```json\n{"heading": "Example"}\n```'),
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/responses",
      jsonPost({
        model: "auto",
        input: "extract the heading",
        text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } },
      }),
    );
    const body = await res.json();
    assert.equal(body.output[0].content[0].text, '{"heading":"Example"}');
    // Schema directive must be in the prompt.
    assert.match(client.sessions[0].lastPrompt, /<output-format>/);
  });

  it("translates a tool_call reply into a function_call item", async () => {
    const client = fakeClient({
      script: replyWith('{"tool_call": {"name": "click", "arguments": {"selector": "#go"}}}'),
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/responses",
      jsonPost({
        model: "auto",
        input: "click go",
        tools: [{ type: "function", name: "click", description: "Click", parameters: { type: "object" } }],
      }),
    );
    const body = await res.json();
    const call = body.output[0];
    assert.equal(call.type, "function_call");
    assert.equal(call.name, "click");
    assert.deepEqual(JSON.parse(call.arguments), { selector: "#go" });
    assert.match(client.sessions[0].lastPrompt, /<tools>/);
  });

  it("ignores tool_call JSON naming an undeclared tool", async () => {
    const client = fakeClient({
      script: replyWith('{"tool_call": {"name": "hack", "arguments": {}}}'),
    });
    const app = createApp(client, testConfig());
    const res = await app.request(
      "/v1/responses",
      jsonPost({
        model: "auto",
        input: "hi",
        tools: [{ type: "function", name: "click", description: "Click", parameters: {} }],
      }),
    );
    const body = await res.json();
    assert.equal(body.output[0].type, "message");
  });

  it("renders function_call/function_call_output history items", async () => {
    const client = fakeClient({ script: replyWith("done") });
    const app = createApp(client, testConfig());
    await app.request(
      "/v1/responses",
      jsonPost({
        model: "auto",
        input: [
          { role: "user", content: "click go" },
          { type: "function_call", call_id: "call_1", name: "click", arguments: '{"selector":"#go"}' },
          { type: "function_call_output", call_id: "call_1", output: "clicked" },
        ],
      }),
    );
    const prompt = client.sessions[0].lastPrompt;
    assert.match(prompt, /"tool_call".*"click"/);
    assert.match(prompt, /Tool result for call_1: clicked/);
  });

  it("rejects streaming requests", async () => {
    const app = createApp(fakeClient(), testConfig());
    const res = await app.request(
      "/v1/responses",
      jsonPost({ model: "auto", input: "hi", stream: true }),
    );
    assert.equal(res.status, 400);
  });
});
