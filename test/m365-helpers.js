/**
 * A scripted stand-in for a `ws` WebSocket, so the M365 adapter can be
 * exercised without a live substrate.office.com connection.
 *
 * It speaks the EventEmitter-style API the adapter uses (`on`/`once`/`send`/
 * `close`). `serverScript(fake)` is invoked once the client sends its chat
 * invocation; drive the turn by calling `fake.server(...)` with raw frame
 * strings the server would send back.
 */
import { EventEmitter } from "node:events";
import { encodeFrame } from "../src/adapters/m365/protocol.js";

export class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    // Open on the next tick, like a real socket.
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    // The first frame is the SignalR handshake; ack it. The second is the
    // chat invocation; hand control to the script.
    if (this.sent.length === 1) {
      queueMicrotask(() => this.emit("message", encodeFrame({})));
    } else if (this.sent.length === 2 && this._script) {
      queueMicrotask(() => this._script(this));
    }
  }

  /** Emit raw server payloads (already record-separator framed). */
  server(...payloads) {
    for (const p of payloads) this.emit("message", p);
  }

  onChat(script) {
    this._script = script;
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

/** Build a WebSocket impl bound to a server script for one connection. */
export function fakeWsImpl(script) {
  return class ScriptedWs extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onChat(script);
    }
  };
}

/**
 * A syntactically valid unsigned JWT with the given claims (for decode tests).
 * Not cryptographically signed — the adapter never verifies signatures.
 */
export function fakeJwt(claims) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;
}
