# copilot2api

**OpenAI- and Anthropic-compatible local API server for GitHub Copilot and Microsoft 365 Copilot.**

Point any tool that speaks the OpenAI or Anthropic API at your Copilot
subscription. Two backends are available behind one HTTP surface, selected with
`--mode`:

- **`copilot`** (default) — GitHub Copilot, via the official
  [`@github/copilot-sdk`](https://github.com/github/copilot-sdk), which bundles
  the Copilot CLI (no separate install needed).
- **`m365`** — Microsoft 365 Copilot ("Bizchat"), via its SignalR-over-WebSocket
  endpoint on `substrate.office.com`.

Both modes expose the same endpoints (`/v1/chat/completions`, `/v1/messages`,
`/v1/responses`, `/v1/models`) and are chosen through an adapter layer, so your
client code does not change between them.

```
Your app (OpenAI/Anthropic HTTP client)
        ↓  HTTP · http://127.0.0.1:4141/v1
copilot2api  ──────────────┬───────────────────────────┐
   copilot adapter         │        m365 adapter        │
        ↓ JSON-RPC         │        ↓ SignalR/WebSocket │
   Copilot CLI (bundled)   │        ↓ (0x1E JSON frames)│
        ↓                  │   wss://substrate.office.com
   GitHub Copilot          │        ↓
                           │   Microsoft 365 Copilot
```

## Install

```sh
npm install -g copilot2api
```

or via Homebrew:

```sh
brew tap asllani94/tap
brew install copilot2api
```

## Quick start

```sh
copilot2api login   # one-time GitHub device-flow sign-in
copilot2api         # start the server on http://127.0.0.1:4141/v1
```

Then use it with any OpenAI client:

```js
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://127.0.0.1:4141/v1", apiKey: "unused" });
const res = await openai.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
```

Or plain `curl`:

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello, how many r letters are there in strawberry word"}]}'
```

## Microsoft 365 Copilot mode

> **Credits.** The M365 Copilot wire protocol (the SignalR-over-WebSocket
> handshake, connection URL, and chat payload) is a JavaScript port of
> [**HEXUXIU/M365-Copilot2API**](https://github.com/HEXUXIU/M365-Copilot2API).
> All credit for reverse-engineering that protocol goes to that project; this
> mode reimplements it to stay 1:1 with those requests. Thank you.

Run the same server against Microsoft 365 Copilot instead of GitHub Copilot by
setting `--mode m365` and supplying a Microsoft-issued access token:

```sh
export COPILOT2API_M365_TOKEN="eyJ0eXAiOiJKV1Qi..."   # substrate access token
copilot2api --mode m365
```

Then call it exactly like the default mode. M365 exposes conversation **tones**
rather than raw models, surfaced as three model ids:

| Model id    | Tone       |
| ----------- | ---------- |
| `auto`      | Magic (balanced) |
| `quick`     | Chat (fast)      |
| `reasoning` | Reasoning (deep) |

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"reasoning","messages":[{"role":"user","content":"Summarize our Q3 strategy deck."}]}'
```

### Authentication & security

The two modes authenticate very differently, on purpose. Read this before
deploying M365 mode.

**`copilot` mode** uses your local GitHub Copilot login (device flow). The token
lives in the OS keychain and is managed by the bundled Copilot CLI/SDK — this
proxy never reads, stores, or forwards it. Sign in once with `copilot2api login`.

**`m365` mode** performs **no interactive login and runs no OAuth flow of its
own**. You obtain a token through Microsoft's own sign-in and hand it to the
proxy out-of-band via **config or environment only**:

| Setting   | Env var(s)                                            | Config file (`m365.*`) | Required |
| --------- | ----------------------------------------------------- | ---------------------- | -------- |
| Token     | `COPILOT2API_M365_TOKEN`, `M365_COPILOT_TOKEN`        | `token`                | Yes      |
| Tenant ID | `COPILOT2API_M365_TENANT_ID`, `M365_TENANT_ID`        | `tenantId`             | Auto\*   |
| User OID  | `COPILOT2API_M365_USER_OID`, `M365_USER_OID`          | `userOid`              | Auto\*   |

\* Tenant ID and user OID are read from the token's own `tid`/`oid` claims when
you don't set them explicitly.

#### Getting an M365 access token

The token you need is the **substrate ("Sydney") access token** — the same one
your browser uses to talk to Copilot. The most reliable way to get it is to copy
it out of a live Copilot session in your browser. This works the same for a
Netherlands / EU tenant as anywhere else (see the region note below).

1. In a browser, sign in to **<https://m365.cloud.microsoft/>** with your work
   account and open **Copilot** (the chat).
2. Open DevTools (**F12**) → **Network** tab, and set the filter to **WS**
   (WebSocket).
3. Send Copilot any message to make it open its connection.
4. Click the WebSocket request to **`substrate.office.com`** (its name contains
   `ChatHub`). In **Headers**, find the **Request URL** and copy the value of the
   **`access_token`** query parameter — a long string starting with `eyJ…`.
   That is your token.
5. Hand it to the proxy (environment variable, never a flag):

   ```sh
   export COPILOT2API_M365_TOKEN="eyJ0eXAiOiJKV1Qi..."
   copilot2api --mode m365
   ```

If DevTools hides the query string, use the browser **Console** instead — right
after logging in, the token is in the MSAL cache in local storage:

```js
// Run in the console on m365.cloud.microsoft; prints the substrate token.
Object.entries(localStorage)
  .filter(([k]) => k.includes("substrate.office.com/sydney"))
  .map(([, v]) => JSON.parse(v).secret)
  .filter(Boolean)[0];
```

You don't need to look up your tenant ID or user OID separately — the proxy
reads them from the token's `tid` and `oid` claims automatically.

> **Netherlands / EU accounts.** The steps are identical: sign-in and token
> capture happen on the global `m365.cloud.microsoft` portal, and the token is
> presented to `substrate.office.com`, which routes to the datacenter your
> tenant lives in (EU tenants stay within the Microsoft EU Data Boundary). The
> token embeds your tenant, and the proxy auto-detects your local time zone and
> locale (e.g. `Europe/Amsterdam`, `nl-NL`) for each request — nothing
> region-specific to configure.

The token is a bearer credential — treat it like a password. It typically
expires in about an hour; when it does, repeat the steps above for a fresh one.

Guarantees this mode holds to — enforced in code and covered by tests:

- **The token is sent to exactly one destination:** `wss://substrate.office.com`,
  the Microsoft endpoint that issued and consumes it (required to open the
  authenticated WebSocket). It goes nowhere else.
- **The token is never forwarded to the model.** Only your prompt text is placed
  in the chat payload; the credential is never part of what the LLM sees.
- **The token is never logged.** Connection URLs (which carry the token as the
  query parameter substrate requires) are redacted before appearing in any log
  or error message.
- **The token is decoded only locally**, to read `oid`/`tid` and check expiry.
  Its signature is never verified over the network — the proxy is the bearer,
  not the audience.
- **No CLI flag accepts the token**, so it can't leak into shell history or the
  process list. Config file or environment variable only.

Tokens are short-lived (typically ~1 hour). When one expires the proxy returns a
clear `401` telling you to supply a fresh token; refreshing it is up to your own
Microsoft sign-in process.

#### Disclaimer

> M365 mode talks to a **private, undocumented** Microsoft interface that was
> reverse-engineered by [HEXUXIU/M365-Copilot2API](https://github.com/HEXUXIU/M365-Copilot2API);
> this is a best-effort reimplementation and may break at any time if Microsoft
> changes the backend.
>
> This project is **not affiliated with, endorsed by, or supported by Microsoft
> or GitHub.** "Microsoft 365", "Copilot", and related marks belong to their
> respective owners. M365 mode is provided **as-is, without warranty of any
> kind**, and you use it **at your own risk** — including any risk to your
> account. Automating or accessing Microsoft 365 Copilot outside the official
> clients may violate your Microsoft 365 or organizational terms of service;
> **you are responsible for ensuring you are authorized to use it**, and for
> complying with your organization's policies and applicable law. If in doubt,
> don't.

## Endpoints

| Endpoint                          | Description                                        |
| --------------------------------- | -------------------------------------------------- |
| `POST /v1/chat/completions`       | Chat completions — streaming (SSE) & non-streaming, with function-tool calling (prompt-shimmed) |
| `POST /v1/responses`              | Responses API — structured JSON output (`text.format`) and function tools, both prompt-shimmed (non-streaming) |
| `POST /v1/messages`               | Anthropic Messages API — streaming & non-streaming, with tool use (prompt-shimmed) |
| `POST /v1/messages/count_tokens`  | Anthropic token counting (size-based estimate)     |
| `GET /v1/models`                  | Models your Copilot plan/policy exposes            |
| `GET /health`                     | Liveness probe (never requires auth)               |

`POST /chat/completions` and `GET /models` also work without the `/v1`
prefix, for clients that append their own path.

The Responses API support is enough to drive AI-SDK-based frameworks — see
[`examples/stagehand`](examples/stagehand) for AI browser automation
([Stagehand](https://github.com/browserbase/stagehand) + Playwright) running
entirely on your Copilot subscription.

### Tool calling

The Copilot SDK only ever returns assistant *text*, so function tools are
bridged with a text protocol: the tools you pass are described in the system
message, the model emits `[tool_call]{...}[/tool_call]` blocks, and the proxy
parses them back into OpenAI `tool_calls` / Anthropic `tool_use` — including
mid-stream. It works well with capable models, but it is a shim: expect it to
be less robust than native tool calling.

### Claude Code

`/v1/messages` is enough to run Anthropic-native tools against Copilot:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 \
ANTHROPIC_API_KEY=unused \
claude
```

If your Copilot plan only exposes `auto`, alias the model IDs Claude Code
asks for via `modelMap` (see Configuration):

```json
{ "modelMap": { "claude-sonnet-4": "auto", "claude-haiku-4": "auto" } }
```

## Configuration

Precedence: **CLI flags > environment variables > config file > defaults.**

| Setting   | Flag              | Env var                                         | Config file key | Default                            |
| --------- | ----------------- | ----------------------------------------------- | --------------- | ---------------------------------- |
| Mode      | `--mode`          | `COPILOT2API_MODE`                              | `mode`          | `copilot`                          |
| Port      | `-p, --port`      | `COPILOT2API_PORT`                              | `port`          | `4141`                             |
| Host      | `--host`          | `COPILOT2API_HOST`                             | `host`          | `127.0.0.1`                        |
| API key   | `--api-key`       | `COPILOT2API_API_KEY`                          | `apiKey`        | _(none — no auth)_                 |
| Model map | —                 | —                                              | `modelMap`      | `{}`                               |
| M365 token | — _(no flag)_    | `COPILOT2API_M365_TOKEN`, `M365_COPILOT_TOKEN` | `m365.token`    | _(none)_                           |
| M365 tenant | — _(no flag)_   | `COPILOT2API_M365_TENANT_ID`, `M365_TENANT_ID` | `m365.tenantId` | _(from token `tid`)_               |
| M365 user OID | — _(no flag)_ | `COPILOT2API_M365_USER_OID`, `M365_USER_OID`   | `m365.userOid`  | _(from token `oid`)_               |
| Config    | `-c, --config`    | —                                              | —               | `~/.config/copilot2api/config.json` |

Example config file (`~/.config/copilot2api/config.json`):

```json
{
  "port": 4141,
  "apiKey": "my-local-secret",
  "modelMap": { "claude-sonnet-4": "auto" }
}
```

Example config file for M365 mode:

```json
{
  "mode": "m365",
  "apiKey": "my-local-secret",
  "m365": { "token": "eyJ0eXAiOiJKV1Qi..." }
}
```

The `apiKey` above is the *inbound* key your own clients must present to this
proxy; it is unrelated to the M365 token and is never forwarded upstream.

When an API key is set, API routes require it as `Authorization: Bearer <key>`
(OpenAI style) or `x-api-key: <key>` (Anthropic style).

`modelMap` defines display-ID aliases: keys are accepted as `model` in
requests and translated to the mapped Copilot model ID. Useful when a client
insists on specific model names but your plan only exposes `auto`.
`/v1/models` is unaffected — it lists exactly what your plan exposes.

## Notes & limitations

- **Local by design.** Binds to `127.0.0.1` by default; the server fronts your
  Copilot credentials, so treat it like a credential itself.
- **Chat-only bridge.** In `copilot` mode, Copilot's agent tools are disabled,
  permission requests are rejected, and the SDK's default system message (which
  describes the proxy host's own directory) is replaced with yours — it behaves
  as a pure model endpoint.
- Each request runs in a fresh session; the message history is rendered into a
  single transcript prompt (both modes are stateless per request).
- Available models depend on the backend: `copilot` mode lists what your Copilot
  plan/org policy exposes (you may only see `auto`); `m365` mode exposes the
  three tone-backed ids (`auto`/`quick`/`reasoning`).
- `usage` token counts are not reported by either backend and are returned as
  zeros; `/v1/messages/count_tokens` returns a size-based estimate.
- Anthropic/OpenAI request fields with no backend equivalent (`max_tokens`,
  `temperature`, `metadata`, ...) are accepted and ignored.
- `copilot` mode requires an active GitHub Copilot subscription and is subject to
  [GitHub's terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot).
  `m365` mode requires a Microsoft 365 Copilot license and is subject to your
  organization's Microsoft 365 terms. Check your org's policies before deploying
  either beyond personal use.

## Troubleshooting

**"Session was not created with authentication info" right after installing** —
the Copilot token lives in the macOS keychain, and the first access from a new
binary (e.g. a fresh Homebrew install) can be denied non-interactively. Run one
interactive command to grant access, then restart the server:

```sh
copilot2api login   # or re-run it; answering the keychain prompt once is enough
```

## Development

```sh
git clone https://github.com/asllani94/copilot2api
cd copilot2api
npm install
npm start
```

## License

[MIT](LICENSE)
