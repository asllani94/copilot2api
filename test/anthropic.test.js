import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countTokens,
  MessagesStream,
  parseMessagesRequest,
  toAnthropicError,
  toMessagesResponse,
} from "../src/anthropic.js";

describe("parseMessagesRequest", () => {
  it("renders a single user message as-is", () => {
    const req = parseMessagesRequest({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(req.prompt, "hi");
    assert.equal(req.system, "");
    assert.equal(req.stream, false);
  });

  it("accepts system as a string or content blocks", () => {
    const asString = parseMessagesRequest({
      model: "auto",
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(asString.system, "Be terse.");

    const asBlocks = parseMessagesRequest({
      model: "auto",
      system: [{ type: "text", text: "Be terse." }],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(asBlocks.system, "Be terse.");
  });

  it("appends the tool protocol for Anthropic tools", () => {
    const req = parseMessagesRequest({
      model: "auto",
      tools: [{ name: "click", description: "Click", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "go" }],
    });
    assert.match(req.system, /# Tool calling protocol/);
    assert.match(req.system, /- click: Click/);
    assert.match(req.system, /"type":"object"/);
  });

  it("renders tool_use and tool_result blocks in the transcript", () => {
    const req = parseMessagesRequest({
      model: "auto",
      messages: [
        { role: "user", content: "click go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Clicking." },
            { type: "tool_use", id: "toolu_1", name: "click", input: { s: "#go" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "clicked" }],
        },
      ],
    });
    assert.match(req.prompt, /Assistant: Clicking\.\n\[tool_call\]\{"name":"click","arguments":\{"s":"#go"\}\}\[\/tool_call\]/);
    assert.match(req.prompt, /Tool result \(toolu_1\): clicked/);
  });

  it("requires model and messages", () => {
    assert.throws(() => parseMessagesRequest({ messages: [{ role: "user", content: "x" }] }), /'model'/);
    assert.throws(() => parseMessagesRequest({ model: "auto", messages: [] }), /'messages'/);
  });
});

describe("toMessagesResponse", () => {
  it("wraps plain text in a text block", () => {
    const res = toMessagesResponse("auto", { text: "pong", toolCalls: [] });
    assert.match(res.id, /^msg_/);
    assert.equal(res.type, "message");
    assert.equal(res.role, "assistant");
    assert.deepEqual(res.content, [{ type: "text", text: "pong" }]);
    assert.equal(res.stop_reason, "end_turn");
    assert.deepEqual(res.usage, { input_tokens: 0, output_tokens: 0 });
  });

  it("emits tool_use blocks with parsed input and tool_use stop reason", () => {
    const res = toMessagesResponse("auto", {
      text: "",
      toolCalls: [{ id: "call_0", name: "click", arguments: '{"s":"#go"}' }],
    });
    assert.deepEqual(res.content, [
      { type: "tool_use", id: "call_0", name: "click", input: { s: "#go" } },
    ]);
    assert.equal(res.stop_reason, "tool_use");
  });
});

describe("MessagesStream", () => {
  it("produces the canonical text-only event sequence", () => {
    const state = new MessagesStream("auto");
    const events = [
      ...state.start(),
      ...state.text("po"),
      ...state.text("ng"),
      ...state.finish("end_turn"),
    ];
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
    assert.equal(events[0].data.message.role, "assistant");
    assert.deepEqual(events[1].data.content_block, { type: "text", text: "" });
    assert.equal(events[2].data.delta.text, "po");
    assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");
  });

  it("closes the text block before a tool_use block and tracks indices", () => {
    const state = new MessagesStream("auto");
    const events = [
      ...state.start(),
      ...state.text("Clicking."),
      ...state.toolCall("call_0", "click", '{"s":"#go"}'),
      ...state.finish("tool_use"),
    ];
    assert.deepEqual(
      events.map((e) => e.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const toolStart = events[4].data;
    assert.equal(toolStart.index, 1);
    assert.deepEqual(toolStart.content_block, { type: "tool_use", id: "call_0", name: "click", input: {} });
    assert.deepEqual(events[5].data.delta, { type: "input_json_delta", partial_json: '{"s":"#go"}' });
    assert.equal(events.at(-2).data.delta.stop_reason, "tool_use");
  });
});

describe("countTokens", () => {
  it("estimates from request size", () => {
    const { input_tokens } = countTokens({
      model: "auto",
      messages: [{ role: "user", content: "x".repeat(400) }],
    });
    assert.ok(input_tokens >= 100, `expected >= 100, got ${input_tokens}`);
  });

  it("requires messages", () => {
    assert.throws(() => countTokens({ model: "auto" }), /'messages'/);
  });
});

describe("toAnthropicError", () => {
  it("maps server_error to api_error", () => {
    assert.deepEqual(toAnthropicError("boom", "server_error"), {
      type: "error",
      error: { type: "api_error", message: "boom" },
    });
  });

  it("passes other types through", () => {
    assert.equal(toAnthropicError("no").error.type, "invalid_request_error");
  });
});
