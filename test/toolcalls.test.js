import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseToolCalls,
  TOOL_CLOSE,
  TOOL_OPEN,
  ToolCallParser,
  toolCallBlock,
  toolInstructions,
} from "../src/toolcalls.js";

const block = (name, args) => `${TOOL_OPEN}{"name":"${name}","arguments":${args}}${TOOL_CLOSE}`;

/** Feed chunks through a parser and collect what it emits. */
function run(chunks) {
  const parser = new ToolCallParser();
  const text = [];
  const calls = [];
  const onText = (t) => text.push(t);
  const onCall = (index, id, name, args) => calls.push({ index, id, name, args });
  for (const chunk of chunks) parser.feed(chunk, onText, onCall);
  parser.flush(onText, onCall);
  return { text: text.join(""), calls, sawToolCall: parser.sawToolCall };
}

describe("toolInstructions", () => {
  it("lists each tool with its schema", () => {
    const text = toolInstructions([
      { name: "click", description: "Click", parameters: { type: "object" } },
    ]);
    assert.match(text, /# Tool calling protocol/);
    assert.match(text, /- click: Click\n {2}input schema: \{"type":"object"\}/);
  });
});

describe("toolCallBlock", () => {
  it("renders string and object arguments", () => {
    assert.equal(toolCallBlock("f", '{"a":1}'), block("f", '{"a":1}'));
    assert.equal(toolCallBlock("f", { a: 1 }), block("f", '{"a":1}'));
    assert.equal(toolCallBlock("f", undefined), block("f", "{}"));
    assert.equal(toolCallBlock("f", ""), block("f", "{}"));
  });
});

describe("ToolCallParser", () => {
  it("passes plain text through", () => {
    const { text, calls } = run(["hello ", "world"]);
    assert.equal(text, "hello world");
    assert.deepEqual(calls, []);
  });

  it("parses a tool call with surrounding text", () => {
    const { text, calls, sawToolCall } = run([`before ${block("click", '{"s":"#go"}')} after`]);
    assert.equal(text, "before  after");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "click");
    assert.equal(calls[0].args, '{"s":"#go"}');
    assert.equal(calls[0].index, 0);
    assert.match(calls[0].id, /^call_[0-9a-f]{8}_0$/);
    assert.equal(sawToolCall, true);
  });

  it("parses multiple calls with increasing indices", () => {
    const { calls } = run([block("a", "{}") + block("b", "{}")]);
    assert.deepEqual(
      calls.map((c) => [c.index, c.name]),
      [
        [0, "a"],
        [1, "b"],
      ],
    );
  });

  it("handles a block split across many chunks", () => {
    const whole = `x${block("click", '{"s":"#go"}')}y`;
    for (const size of [1, 3, 7]) {
      const chunks = [];
      for (let i = 0; i < whole.length; i += size) chunks.push(whole.slice(i, i + size));
      const { text, calls } = run(chunks);
      assert.equal(text, "xy", `chunk size ${size}`);
      assert.equal(calls.length, 1, `chunk size ${size}`);
    }
  });

  it("does not leak a partial open tag while waiting for more input", () => {
    const parser = new ToolCallParser();
    const text = [];
    parser.feed("hello [tool_c", (t) => text.push(t), () => {});
    assert.equal(text.join(""), "hello ");
  });

  it("emits an invalid block as raw text", () => {
    const { text, calls } = run([`${TOOL_OPEN}not json${TOOL_CLOSE}`]);
    assert.equal(text, `${TOOL_OPEN}not json${TOOL_CLOSE}`);
    assert.deepEqual(calls, []);
  });

  it("salvages an unterminated block at end of stream", () => {
    const { text, calls } = run([`${TOOL_OPEN}{"name":"click","arguments":{}}`]);
    assert.equal(text, "");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "click");
  });

  it("salvages a block with a truncated close tag", () => {
    const { calls } = run([`${TOOL_OPEN}{"name":"click","arguments":{}}[/tool_c`]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "click");
  });

  it("flushes unparseable trailing content as text", () => {
    const { text, calls } = run([`${TOOL_OPEN}{"name":`]);
    assert.equal(text, `${TOOL_OPEN}{"name":`);
    assert.deepEqual(calls, []);
  });

  it("defaults null arguments to an empty object", () => {
    const { calls } = run([block("f", "null")]);
    assert.equal(calls[0].args, "{}");
  });
});

describe("parseToolCalls", () => {
  it("splits a complete reply into text and calls", () => {
    const { text, toolCalls } = parseToolCalls(`ok ${block("a", '{"x":1}')}`);
    assert.equal(text, "ok ");
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(JSON.parse(toolCalls[0].arguments), { x: 1 });
  });
});
