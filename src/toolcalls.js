/**
 * Prompt-shimmed tool calling, shared by the OpenAI and Anthropic bridges.
 *
 * The Copilot SDK runs its own agent loop and only ever streams assistant
 * *text* back — it never surfaces native tool calls. So the caller's tools
 * are described in the system message together with a text protocol: the
 * model emits `[tool_call]{"name":...,"arguments":{...}}[/tool_call]`
 * blocks, which are parsed back out of the (possibly streamed) reply into
 * structured tool calls.
 */
import crypto from "node:crypto";

export const TOOL_OPEN = "[tool_call]";
export const TOOL_CLOSE = "[/tool_call]";

/**
 * Render the tool catalogue and calling protocol as system-message text.
 * @param {Array<{name: string, description?: string, parameters?: object}>} tools
 */
export function toolInstructions(tools) {
  const catalogue = tools.map(
    (t) =>
      `- ${t.name}: ${t.description ?? ""}\n  input schema: ${JSON.stringify(t.parameters ?? {})}`,
  );
  return [
    "# Tool calling protocol",
    "You can call the tools listed below. When you decide to call a tool, output one or more blocks EXACTLY in this format:",
    `${TOOL_OPEN}{"name":"<tool name>","arguments":{<arguments as a JSON object>}}${TOOL_CLOSE}`,
    "Rules:",
    "- `arguments` MUST be a valid JSON object matching that tool's input schema.",
    `- Every block MUST end with the closing tag ${TOOL_CLOSE} — never stop before writing it.`,
    "- Emit one block per tool call; you may emit several blocks to call multiple tools.",
    "- Do NOT wrap blocks in code fences and do NOT invent tools that are not listed.",
    "- After emitting tool-call block(s), stop and wait for the tool results before continuing.",
    "",
    "Available tools:",
    ...catalogue,
  ].join("\n");
}

/**
 * Re-render a prior tool call in protocol form, so transcript history shows
 * the model what it previously requested.
 * @param {string} name
 * @param {string|object|undefined} args JSON string or plain object.
 */
export function toolCallBlock(name, args) {
  let argsJson = "{}";
  if (typeof args === "string") {
    if (args.trim()) argsJson = args;
  } else if (args != null) {
    argsJson = JSON.stringify(args);
  }
  return `${TOOL_OPEN}{"name":${JSON.stringify(name)},"arguments":${argsJson}}${TOOL_CLOSE}`;
}

/**
 * Streaming-safe parser that extracts protocol blocks out of a text stream,
 * emitting plain text and parsed tool calls via callbacks. Tolerates markers
 * split across feed() calls.
 *
 * Callbacks: `onText(text)` receives text outside any block;
 * `onToolCall(index, id, name, argsJson)` receives a parsed call.
 */
export class ToolCallParser {
  #pending = "";
  #seq = 0;
  #idPrefix = crypto.randomBytes(4).toString("hex");
  sawToolCall = false;

  feed(text, onText, onToolCall) {
    this.#pending += text;
    for (;;) {
      const open = this.#pending.indexOf(TOOL_OPEN);
      if (open === -1) {
        // No open tag in view. Flush everything except a suffix that could
        // be the beginning of an open tag split across chunks.
        const keep = partialOpenSuffix(this.#pending);
        const flush = this.#pending.slice(0, this.#pending.length - keep);
        if (flush) onText(flush);
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        return;
      }
      if (open > 0) onText(this.#pending.slice(0, open));
      const rest = this.#pending.slice(open + TOOL_OPEN.length);
      const closeIdx = rest.indexOf(TOOL_CLOSE);
      if (closeIdx === -1) {
        // Incomplete block; wait for more input.
        this.#pending = this.#pending.slice(open);
        return;
      }
      const block = rest.slice(0, closeIdx);
      if (!this.#handleBlock(block.trim(), onToolCall)) {
        // Not a valid tool call — surface the raw block so nothing is lost.
        onText(TOOL_OPEN + block + TOOL_CLOSE);
      }
      this.#pending = rest.slice(closeIdx + TOOL_CLOSE.length);
    }
  }

  /**
   * Drain the buffer at end of stream. Models sometimes stop right after the
   * JSON payload without writing the close tag, so an unterminated block
   * whose payload parses cleanly is salvaged as a tool call; anything else
   * is emitted as text so no content is dropped.
   */
  flush(onText, onToolCall) {
    if (!this.#pending) return;
    if (this.#pending.startsWith(TOOL_OPEN)) {
      let inner = this.#pending.slice(TOOL_OPEN.length).trim();
      // Tolerate a truncated close tag after the payload.
      for (let k = TOOL_CLOSE.length - 1; k > 0; k--) {
        if (inner.endsWith(TOOL_CLOSE.slice(0, k))) {
          inner = inner.slice(0, inner.length - k).trim();
          break;
        }
      }
      if (this.#handleBlock(inner, onToolCall)) {
        this.#pending = "";
        return;
      }
    }
    onText(this.#pending);
    this.#pending = "";
  }

  #handleBlock(jsonText, onToolCall) {
    let call;
    try {
      call = JSON.parse(jsonText);
    } catch {
      return false;
    }
    if (!call || typeof call.name !== "string" || !call.name) return false;
    const args = call.arguments == null ? {} : call.arguments;
    const index = this.#seq++;
    onToolCall(index, `call_${this.#idPrefix}_${index}`, call.name, JSON.stringify(args));
    this.sawToolCall = true;
    return true;
  }
}

/** Split a complete reply into its text and tool calls. */
export function parseToolCalls(reply) {
  const parser = new ToolCallParser();
  const textParts = [];
  const toolCalls = [];
  const onText = (t) => textParts.push(t);
  const onToolCall = (index, id, name, args) =>
    toolCalls.push({ index, id, name, arguments: args });
  parser.feed(reply, onText, onToolCall);
  parser.flush(onText, onToolCall);
  return { text: textParts.join(""), toolCalls };
}

/**
 * Length of the longest suffix of `s` that is also a proper prefix of the
 * open tag, so a marker split across chunks isn't leaked as plain text.
 */
function partialOpenSuffix(s) {
  const max = Math.min(TOOL_OPEN.length - 1, s.length);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(TOOL_OPEN.slice(0, k))) return k;
  }
  return 0;
}
