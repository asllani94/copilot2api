import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completionMeta,
  contentToText,
  renderPrompt,
  toChatCompletion,
  toChunk,
  toErrorBody,
  toModelList,
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

describe("renderPrompt", () => {
  it("sends a single user message as-is", () => {
    assert.equal(renderPrompt([{ role: "user", content: "hi" }]), "hi");
  });

  it("wraps system messages in an instructions block", () => {
    const prompt = renderPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);
    assert.match(prompt, /^<instructions>\nBe terse\.\n<\/instructions>\n\nhi$/);
  });

  it("renders multi-turn history as a labelled transcript", () => {
    const prompt = renderPrompt([
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
    const prompt = renderPrompt([
      { role: "developer", content: "Rule." },
      { role: "user", content: "hi" },
    ]);
    assert.match(prompt, /<instructions>\nRule\.\n<\/instructions>/);
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
    const body = toChatCompletion({ id: "chatcmpl-x", created: 1, model: "auto" }, "hi");
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "hi");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("toChunk carries a delta and finish reason", () => {
    const chunk = toChunk({ id: "chatcmpl-x", created: 1, model: "auto" }, { content: "h" }, null);
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.deepEqual(chunk.choices[0].delta, { content: "h" });
    assert.equal(chunk.choices[0].finish_reason, null);
  });

  it("toErrorBody matches the OpenAI error envelope", () => {
    assert.deepEqual(toErrorBody("nope", "server_error"), {
      error: { message: "nope", type: "server_error", param: null, code: null },
    });
  });
});
