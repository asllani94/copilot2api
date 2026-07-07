import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completionMeta,
  contentToText,
  renderChat,
  toChatCompletion,
  toChunk,
  toErrorBody,
  toModelList,
  toolCallDelta,
} from "../src/openai.js";

describe("contentToText", () => {
  it("passes strings through", () => {
    assert.equal(contentToText("hello"), "hello");
  });

  it("joins text parts of a content array", () => {
    assert.equal(
      contentToText([
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "..." } },
        { type: "text", text: "b" },
      ]),
      "a\nb",
    );
  });

  it("returns empty string for unsupported content", () => {
    assert.equal(contentToText(null), "");
    assert.equal(contentToText(42), "");
  });
});

describe("renderChat", () => {
  it("sends a single user message as-is, with empty system", () => {
    assert.deepEqual(renderChat([{ role: "user", content: "hi" }]), { system: "", prompt: "hi" });
  });

  it("hoists system messages into the system field", () => {
    const { system, prompt } = renderChat([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);
    assert.equal(system, "Be terse.");
    assert.equal(prompt, "hi");
  });

  it("renders multi-turn history as a labelled transcript", () => {
    const { prompt } = renderChat([
      { role: "user", content: "My name is Erdi." },
      { role: "assistant", content: "Hi Erdi." },
      { role: "user", content: "What is my name?" },
    ]);
    assert.match(prompt, /conversation transcript/);
    assert.match(prompt, /User: My name is Erdi\./);
    assert.match(prompt, /Assistant: Hi Erdi\./);
    assert.match(prompt, /User: What is my name\?$/);
  });

  it("treats developer role like system", () => {
    const { system } = renderChat([
      { role: "developer", content: "Rule." },
      { role: "user", content: "hi" },
    ]);
    assert.equal(system, "Rule.");
  });

  it("appends the tool protocol to the system field", () => {
    const { system, prompt } = renderChat(
      [{ role: "user", content: "click go" }],
      [{ name: "click", description: "Click", parameters: { type: "object" } }],
    );
    assert.match(system, /# Tool calling protocol/);
    assert.match(system, /- click: Click/);
    assert.equal(prompt, "click go");
  });

  it("re-renders assistant tool_calls and tool results in the transcript", () => {
    const { prompt } = renderChat([
      { role: "user", content: "click go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "click", arguments: '{"s":"#go"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "clicked" },
    ]);
    assert.match(prompt, /Assistant:\n\[tool_call\]\{"name":"click","arguments":\{"s":"#go"\}\}\[\/tool_call\]/);
    assert.match(prompt, /Tool result \(call_1\): clicked/);
  });
});

describe("response shapes", () => {
  it("completionMeta produces an OpenAI-style id", () => {
    const meta = completionMeta("auto");
    assert.match(meta.id, /^chatcmpl-/);
    assert.equal(meta.model, "auto");
    assert.equal(typeof meta.created, "number");
  });

  it("toModelList maps SDK models", () => {
    const list = toModelList([{ id: "auto", name: "Auto" }]);
    assert.deepEqual(list, {
      object: "list",
      data: [{ id: "auto", object: "model", created: 0, owned_by: "github-copilot" }],
    });
  });

  it("toChatCompletion wraps content in a single choice", () => {
    const body = toChatCompletion({ id: "chatcmpl-x", created: 1, model: "auto" }, { text: "hi" });
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "hi");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("toChatCompletion carries tool calls with a tool_calls finish reason", () => {
    const body = toChatCompletion(
      { id: "chatcmpl-x", created: 1, model: "auto" },
      { text: "", toolCalls: [{ id: "call_0", name: "click", arguments: '{"s":"#go"}' }] },
    );
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.content, null);
    assert.deepEqual(body.choices[0].message.tool_calls, [
      { id: "call_0", type: "function", function: { name: "click", arguments: '{"s":"#go"}' } },
    ]);
  });

  it("toChunk carries a delta and finish reason", () => {
    const chunk = toChunk({ id: "chatcmpl-x", created: 1, model: "auto" }, { content: "h" }, null);
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.deepEqual(chunk.choices[0].delta, { content: "h" });
    assert.equal(chunk.choices[0].finish_reason, null);
  });

  it("toolCallDelta matches the streaming tool_calls shape", () => {
    assert.deepEqual(toolCallDelta(0, "call_0", "click", "{}"), {
      tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "click", arguments: "{}" } }],
    });
  });

  it("toErrorBody matches the OpenAI error envelope", () => {
    assert.deepEqual(toErrorBody("nope", "server_error"), {
      error: { message: "nope", type: "server_error", param: null, code: null },
    });
  });
});
