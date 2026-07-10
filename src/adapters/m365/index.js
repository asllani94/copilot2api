/**
 * Microsoft 365 Copilot adapter.
 *
 * ── Authentication (read this) ──────────────────────────────────────────────
 * Unlike the GitHub Copilot mode, this adapter does NOT perform any interactive
 * login. You supply a Microsoft-issued access token (the substrate/"Sydney"
 * token) via config or environment; see `resolveM365` in ../../config.js.
 *
 * What this adapter does with that token:
 *   • Decodes it locally to read the `oid`/`tid` claims (only if you did not
 *     provide them explicitly) — no network call, no signature check.
 *   • Sends it to exactly one destination: wss://substrate.office.com, the
 *     Microsoft endpoint that issued and consumes it. This is required to open
 *     the authenticated WebSocket and is the same endpoint the M365 web client
 *     uses.
 *
 * What this adapter never does:
 *   • It never puts the token in a prompt or forwards it to the model.
 *   • It never logs the token (connection URLs are redacted before surfacing).
 *   • It never sends the token to this proxy's own callers or anywhere else.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { ApiError } from "../../errors.js";
import { decodeJwtClaims, isExpired, redactSecrets, secondsUntilExpiry } from "./jwt.js";
import {
  applyUpdateFrame,
  buildChatInvocation,
  buildWsUrl,
  cleanText,
  decodeFrames,
  encodeFrame,
  FRAME,
  HANDSHAKE_REQUEST,
  M365_MODELS,
  MAX_PAYLOAD,
  newSessionIds,
  toneForModel,
} from "./protocol.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 120_000;

/**
 * @param {{ token?: string, tenantId?: string, userOid?: string }} m365 Resolved M365 config.
 * @param {{ WebSocketImpl?: any }} [deps] Injectable WebSocket (defaults to `ws`).
 */
export function m365Adapter(m365, deps = {}) {
  const identity = resolveIdentity(m365);

  return {
    mode: "m365",

    listModels() {
      return M365_MODELS.map((m) => ({ id: m.id }));
    },

    createChatSession({ model, stream, system }) {
      // Re-check expiry per request so a token that lapsed while the server was
      // running produces a clear error instead of an opaque socket failure.
      assertUsable(identity);
      return new M365Session({
        identity,
        tone: toneForModel(model),
        system,
        streaming: stream,
        WebSocketImpl: deps.WebSocketImpl,
      });
    },

    async stop() {},
  };
}

/**
 * A single M365 chat turn over one WebSocket connection. Implements the common
 * session event interface consumed by ../../session.js and ../../app.js.
 */
class M365Session {
  #handlers = new Map();
  #ws = null;
  #session = newSessionIds();

  constructor({ identity, tone, system, streaming, WebSocketImpl }) {
    this.identity = identity;
    this.tone = tone;
    this.system = system;
    this.streaming = streaming;
    this.WebSocketImpl = WebSocketImpl;
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(handler);
  }

  #emit(event, data = {}) {
    for (const handler of this.#handlers.get(event) ?? []) handler({ data });
  }

  /** Streaming entry point: fires delta/idle/error events as the turn runs. */
  send({ prompt }) {
    return this.#runTurn(prompt);
  }

  /** Non-streaming entry point: same turn, resolves once it settles. */
  sendAndWait({ prompt }) {
    return this.#runTurn(prompt);
  }

  async #runTurn(prompt) {
    const text = this.system ? `${this.system}\n\n${prompt}` : prompt;
    try {
      const ws = await this.#connect();
      await this.#drive(ws, text);
    } catch (err) {
      this.#emit("session.error", { message: redactSecrets(err?.message ?? String(err)) });
    }
  }

  async #connect() {
    const WebSocketImpl = this.WebSocketImpl ?? (await loadWebSocket());
    const url = buildWsUrl({
      userOid: this.identity.userOid,
      tenantId: this.identity.tenantId,
      token: this.identity.token,
      session: this.#session,
    });
    // Connection options mirror the reference client: a large max payload and
    // no client-initiated keepalive pings. No spoofed browser headers are sent.
    const ws = new WebSocketImpl(url, { maxPayload: MAX_PAYLOAD });
    this.#ws = ws;

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", (err) => reject(redactError(err)));
      }),
      HANDSHAKE_TIMEOUT_MS,
      "Timed out connecting to substrate.office.com",
    );

    // SignalR JSON handshake: send version frame, await the ack frame.
    const handshakeAck = nextMessage(ws);
    ws.send(encodeFrame(HANDSHAKE_REQUEST));
    const ack = await withTimeout(handshakeAck, HANDSHAKE_TIMEOUT_MS, "SignalR handshake timed out");
    const ackFrame = decodeFrames(ack)[0];
    if (ackFrame && ackFrame.error) {
      throw new Error(`SignalR handshake rejected: ${ackFrame.error}`);
    }
    return ws;
  }

  #drive(ws, text) {
    let fullText = "";
    let settled = false;

    return new Promise((resolve) => {
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (message) => {
        this.#emit("session.error", { message: redactSecrets(message) });
        settle();
      };

      const timer = setTimeout(() => fail("M365 turn timed out"), TURN_TIMEOUT_MS);

      ws.on("message", (data) => {
        for (const frame of decodeFrames(data)) {
          if (frame.type === FRAME.INVOCATION) {
            // Stream "update" frames: emit each new delta (reference loop).
            const { deltas, text } = applyUpdateFrame(frame, fullText);
            fullText = text;
            for (const delta of deltas) this.#emit("assistant.message_delta", { deltaContent: delta });
            continue;
          }
          if (frame.type === FRAME.COMPLETION) {
            // Type 3 ends the turn (reference `mt == 3`).
            this.#emit("assistant.message", { content: cleanText(fullText) });
            this.#emit("session.idle");
            return settle();
          }
          if (frame.type === FRAME.ERROR) {
            // Reference `mt == -1`: an error signal aborts the turn.
            return fail(String(frame.error ?? JSON.stringify(frame)).slice(0, 200));
          }
        }
      });
      ws.on("error", (err) => fail(redactError(err).message));
      ws.on("close", () => settle());

      ws.send(encodeFrame(buildChatInvocation({ session: this.#session, text, tone: this.tone })));
    });
  }

  async abort() {
    await this.disconnect();
  }

  async disconnect() {
    if (!this.#ws) return;
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
    this.#ws = null;
  }
}

/** Resolve oid/tid from explicit config, falling back to the token's claims. */
function resolveIdentity(m365) {
  const token = m365?.token;
  if (!token) {
    throw new ApiError(
      401,
      "M365 mode requires an access token (COPILOT2API_M365_TOKEN or m365.token in the config file)",
      "authentication_error",
    );
  }
  let claims = {};
  try {
    claims = decodeJwtClaims(token);
  } catch (err) {
    // Only fatal if we also lack an explicit oid/tid to fall back on.
    if (!m365.userOid || !m365.tenantId) {
      throw new ApiError(401, err.message, "authentication_error");
    }
  }
  const userOid = m365.userOid || claims.oid;
  const tenantId = m365.tenantId || claims.tid;
  if (!userOid || !tenantId) {
    throw new ApiError(
      401,
      "M365 mode needs a user OID and tenant ID: provide them via config/env, or use a token that carries `oid` and `tid` claims",
      "authentication_error",
    );
  }
  return { token, userOid, tenantId, claims };
}

/** Reject expired tokens up front with an actionable message. */
function assertUsable(identity) {
  if (isExpired(identity.claims)) {
    const ago = -secondsUntilExpiry(identity.claims);
    throw new ApiError(
      401,
      `M365 access token has expired (${ago}s ago). Supply a fresh token via COPILOT2API_M365_TOKEN or the config file.`,
      "authentication_error",
    );
  }
}

async function loadWebSocket() {
  try {
    const mod = await import("ws");
    return mod.default ?? mod.WebSocket;
  } catch {
    if (typeof WebSocket !== "undefined") return WebSocket;
    throw new Error("The 'ws' package is required for M365 mode. Run: npm install ws");
  }
}

/** Resolve with the next `message` payload from the socket, or reject on failure. */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", resolve);
    ws.once("error", (err) => reject(redactError(err)));
    ws.once("close", () => reject(new Error("Connection closed before handshake completed")));
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Scrub any token that leaked into a socket error before it propagates. */
function redactError(err) {
  const message = redactSecrets(err?.message ?? String(err));
  return Object.assign(new Error(message), { code: err?.code });
}
