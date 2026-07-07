# copilot2api

**OpenAI- and Anthropic-compatible local API server for GitHub Copilot.**

Point any tool that speaks the OpenAI or Anthropic API at your GitHub Copilot
subscription. Built on the official
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk),
which bundles the Copilot CLI — no separate install needed.

```
Your app (OpenAI/Anthropic HTTP client)
        ↓  HTTP · http://127.0.0.1:4141/v1
copilot2api (@github/copilot-sdk wrapper)
        ↓  JSON-RPC
Copilot CLI (server mode, bundled)
        ↓
GitHub Copilot
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

| Setting  | Flag              | Env var                | Config file key | Default                            |
| -------- | ----------------- | ---------------------- | --------------- | ---------------------------------- |
| Port     | `-p, --port`      | `COPILOT2API_PORT`     | `port`          | `4141`                             |
| Host     | `--host`          | `COPILOT2API_HOST`     | `host`          | `127.0.0.1`                        |
| API key  | `--api-key`       | `COPILOT2API_API_KEY`  | `apiKey`        | _(none — no auth)_                 |
| Model map | —                | —                      | `modelMap`      | `{}`                               |
| Config   | `-c, --config`    | —                      | —               | `~/.config/copilot2api/config.json` |

Example config file (`~/.config/copilot2api/config.json`):

```json
{
  "port": 4141,
  "apiKey": "my-local-secret",
  "modelMap": { "claude-sonnet-4": "auto" }
}
```

When an API key is set, API routes require it as `Authorization: Bearer <key>`
(OpenAI style) or `x-api-key: <key>` (Anthropic style).

`modelMap` defines display-ID aliases: keys are accepted as `model` in
requests and translated to the mapped Copilot model ID. Useful when a client
insists on specific model names but your plan only exposes `auto`.
`/v1/models` is unaffected — it lists exactly what your plan exposes.

## Notes & limitations

- **Local by design.** Binds to `127.0.0.1` by default; the server fronts your
  personal Copilot login, so treat it like a credential.
- **Chat-only bridge.** Copilot's agent tools are disabled, permission
  requests are rejected, and the SDK's default system message (which
  describes the proxy host's own directory) is replaced with yours — it
  behaves as a pure model endpoint.
- Each request runs in a fresh SDK session; the message history is rendered
  into a single transcript prompt.
- Available models are governed by your Copilot plan/org policy (you may only
  see `auto`).
- `usage` token counts are not reported by the SDK and are returned as zeros;
  `/v1/messages/count_tokens` returns a size-based estimate.
- Anthropic request fields with no SDK equivalent (`max_tokens`,
  `temperature`, `metadata`, ...) are accepted and ignored.
- Requires an active GitHub Copilot subscription. Use of Copilot through this
  tool is subject to [GitHub's terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
  and your organization's policies — check before deploying beyond personal use.

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
