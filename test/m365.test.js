import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { m365Adapter } from "../src/adapters/m365/index.js";
import { decodeJwtClaims, isExpired, redactSecrets, secondsUntilExpiry } from "../src/adapters/m365/jwt.js";
import {
  applyUpdateFrame,
  buildChatInvocation,
  buildWsUrl,
  cleanText,
  decodeFrames,
  encodeFrame,
  newSessionIds,
  RS,
  toneForModel,
} from "../src/adapters/m365/protocol.js";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/errors.js";
import { testConfig } from "./helpers.js";
import { fakeJwt, fakeWsImpl } from "./m365-helpers.js";

const OID = "11111111-1111-1111-1111-111111111111";
const TID = "22222222-2222-2222-2222-222222222222";
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("m365 jwt", () => {
  it("decodes claims without verifying the signature", () => {
    const claims = decodeJwtClaims(fakeJwt({ oid: OID, tid: TID, exp: future() }));
    assert.equal(claims.oid, OID);
    assert.equal(claims.tid, TID);
  });

  it("rejects a malformed token", () => {
    assert.throws(() => decodeJwtClaims("not-a-jwt"), /valid JWT/);
    assert.throws(() => decodeJwtClaims(""), /empty/);
  });

  it("computes expiry and detects expired tokens", () => {
    const now = Date.now();
    assert.ok(secondsUntilExpiry({ exp: Math.floor(now / 1000) + 100 }, now) > 0);
    assert.equal(isExpired({ exp: Math.floor(now / 1000) + 100 }, 60, now), false);
    assert.equal(isExpired({ exp: Math.floor(now / 1000) - 10 }, 60, now), true);
    assert.equal(secondsUntilExpiry({}, now), null);
    assert.equal(isExpired({}, 60, now), false);
  });

  it("redacts tokens from strings", () => {
    const jwt = fakeJwt({ oid: OID });
    assert.match(redactSecrets(`wss://x?access_token=${jwt}&foo=1`), /access_token=REDACTED&foo=1/);
    assert.doesNotMatch(redactSecrets(`bare ${jwt} here`), new RegExp(jwt));
  });
});

describe("m365 protocol", () => {
  it("encodes and decodes record-separated frames", () => {
    const frame = encodeFrame({ a: 1 });
    assert.ok(frame.endsWith(RS));
    assert.deepEqual(decodeFrames(frame + encodeFrame({ b: 2 })), [{ a: 1 }, { b: 2 }]);
    // Junk / partial frames are skipped.
    assert.deepEqual(decodeFrames("{bad}" + RS + encodeFrame({ c: 3 })), [{ c: 3 }]);
  });

  it("maps model ids to tones, defaulting to Magic", () => {
    assert.equal(toneForModel("auto"), "Magic");
    assert.equal(toneForModel("quick"), "Chat");
    assert.equal(toneForModel("reasoning"), "Reasoning");
    assert.equal(toneForModel("whatever"), "Magic");
  });

  it("builds an authenticated ws url that carries the token only in the query", () => {
    const session = newSessionIds();
    const url = buildWsUrl({ userOid: OID, tenantId: TID, token: "TKN", session });
    assert.ok(url.startsWith(`wss://substrate.office.com/m365Copilot/Chathub/${OID}@${TID}?`));
    assert.match(url, /access_token=TKN/);
    // And it is fully redactable before logging.
    assert.doesNotMatch(redactSecrets(url), /access_token=TKN/);
  });

  it("requires oid and tid to build a url", () => {
    assert.throws(() => buildWsUrl({ userOid: "", tenantId: TID, token: "t", session: newSessionIds() }), /OID/);
  });

  it("builds a chat invocation with the user text and no credentials", () => {
    const session = newSessionIds();
    const inv = buildChatInvocation({ session, text: "hello world", tone: "Chat" });
    assert.equal(inv.type, 4);
    assert.equal(inv.target, "chat");
    assert.equal(inv.arguments[0].message.text, "hello world");
    assert.equal(inv.arguments[0].tone, "Chat");
    // Nothing token-shaped anywhere in the payload.
    assert.doesNotMatch(JSON.stringify(inv), /access_token/);
  });

  it("reads cumulative and incremental deltas from update frames", () => {
    const cumulative = { type: 1, target: "update", arguments: [{ messages: [{ text: "Hello" }] }] };
    assert.deepEqual(applyUpdateFrame(cumulative, ""), { deltas: ["Hello"], text: "Hello" });
    assert.deepEqual(
      applyUpdateFrame({ ...cumulative, arguments: [{ messages: [{ text: "Hello there" }] }] }, "Hello"),
      { deltas: [" there"], text: "Hello there" },
    );
    const cursor = { type: 1, target: "update", arguments: [{ writeAtCursor: "!" }] };
    assert.deepEqual(applyUpdateFrame(cursor, "Hi"), { deltas: ["!"], text: "Hi!" });
    // A non-update frame yields no deltas and leaves the text untouched.
    assert.deepEqual(applyUpdateFrame({ type: 3 }, "x"), { deltas: [], text: "x" });
  });

  it("cleans trailing control characters", () => {
    assert.equal(cleanText("answer"), "answer");
    assert.equal(cleanText("  spaced  "), "spaced");
  });
});

/** Server frames for a simple streamed reply. */
function streamFrames(chunks) {
  const updates = chunks.map((c) =>
    encodeFrame({ type: 1, target: "update", arguments: [{ writeAtCursor: c }] }),
  );
  return [...updates, encodeFrame({ type: 3, invocationId: "0" })];
}

function adapterWithServer(script, m365 = { token: fakeJwt({ oid: OID, tid: TID, exp: future() }) }) {
  return m365Adapter(m365, { WebSocketImpl: fakeWsImpl(script) });
}

describe("m365 adapter", () => {
  it("lists tone-backed models", () => {
    const adapter = adapterWithServer(() => {});
    assert.deepEqual(
      adapter.listModels().map((m) => m.id),
      ["auto", "quick", "reasoning"],
    );
  });

  it("derives oid/tid from the token when not given explicitly", async () => {
    let connectedUrl;
    const adapter = m365Adapter(
      { token: fakeJwt({ oid: OID, tid: TID, exp: future() }) },
      {
        WebSocketImpl: class extends fakeWsImpl((ws) => ws.server(...streamFrames(["hi"]))) {
          constructor(url, opts) {
            super(url, opts);
            connectedUrl = url;
          }
        },
      },
    );
    const session = adapter.createChatSession({ model: "auto", stream: false, system: "" });
    await drive(session, "ping");
    assert.match(connectedUrl, new RegExp(`Chathub/${OID}@${TID}`));
  });

  it("streams deltas then a final assistant message and idle", async () => {
    const adapter = adapterWithServer((ws) => ws.server(...streamFrames(["Hel", "lo"])));
    const session = adapter.createChatSession({ model: "auto", stream: true, system: "" });
    const events = await drive(session, "hi");
    assert.deepEqual(events.deltas, ["Hel", "lo"]);
    assert.equal(events.message, "Hello");
    assert.equal(events.idle, true);
    assert.equal(events.error, null);
  });

  it("never sends the token or system text as a credential to the model", async () => {
    let chatPayload;
    const adapter = adapterWithServer((ws) => {
      chatPayload = ws.sent[1];
      ws.server(...streamFrames(["ok"]));
    });
    const session = adapter.createChatSession({ model: "auto", stream: false, system: "Be brief." });
    await drive(session, "question");
    // The user prompt (with system prepended) is present; the token is not.
    assert.match(chatPayload, /Be brief\./);
    assert.match(chatPayload, /question/);
    assert.doesNotMatch(chatPayload, /access_token/);
    assert.doesNotMatch(chatPayload, /\.sig/); // no JWT
  });

  it("surfaces an error frame (type -1) as a session error", async () => {
    const adapter = adapterWithServer((ws) =>
      ws.server(encodeFrame({ type: -1, error: "content policy" })),
    );
    const session = adapter.createChatSession({ model: "auto", stream: true, system: "" });
    const events = await drive(session, "hi");
    assert.match(events.error, /content policy/);
  });

  it("rejects a missing token", () => {
    assert.throws(() => m365Adapter({}).createChatSession({ model: "auto" }), ApiError);
  });

  it("rejects an expired token with an actionable error", () => {
    const adapter = m365Adapter({ token: fakeJwt({ oid: OID, tid: TID, exp: 1 }) });
    assert.throws(() => adapter.createChatSession({ model: "auto" }), /expired/);
  });
});

describe("m365 through the HTTP app", () => {
  it("answers /v1/chat/completions via the m365 adapter", async () => {
    const adapter = adapterWithServer((ws) => ws.server(...streamFrames(["po", "ng"])));
    const app = createApp(adapter, testConfig({ mode: "m365" }));
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "pong");
  });

  it("lists the tone-backed models over HTTP", async () => {
    const app = createApp(adapterWithServer(() => {}), testConfig({ mode: "m365" }));
    const body = await (await app.request("/v1/models")).json();
    assert.deepEqual(body.data.map((m) => m.id), ["auto", "quick", "reasoning"]);
  });
});

/** Drive a session to completion, collecting the events it emits. */
function drive(session, prompt) {
  const events = { deltas: [], message: null, idle: false, error: null };
  session.on("assistant.message_delta", (e) => events.deltas.push(e.data.deltaContent));
  session.on("assistant.message", (e) => (events.message = e.data.content));
  session.on("session.idle", () => (events.idle = true));
  session.on("session.error", (e) => (events.error = e.data.message));
  return session.sendAndWait({ prompt }).then(() => events);
}
