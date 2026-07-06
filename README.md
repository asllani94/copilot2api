# copilot2api

**OpenAI-compatible local API server for GitHub Copilot.**

Point any tool that speaks the OpenAI API at your GitHub Copilot subscription.
Built on the official [`@github/copilot-sdk`](https://github.com/github/copilot-sdk),
which bundles the Copilot CLI — no separate install needed.

```
Your app (OpenAI SDK) → http://127.0.0.1:4141/v1 → copilot2api → GitHub Copilot
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
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

## Endpoints

| Endpoint                    | Description                                        |
| --------------------------- | -------------------------------------------------- |
| `POST /v1/chat/completions` | Chat completions — streaming (SSE) & non-streaming |
| `POST /v1/responses`        | Responses API — structured JSON output (`text.format`) and function tools, both prompt-shimmed (non-streaming) |
| `GET /v1/models`            | Models your Copilot plan/policy exposes            |
| `GET /health`               | Liveness probe (never requires auth)               |

The Responses API support is enough to drive AI-SDK-based frameworks — see
[`examples/stagehand`](examples/stagehand) for AI browser automation
([Stagehand](https://github.com/browserbase/stagehand) + Playwright) running
entirely on your Copilot subscription.

## Configuration

Precedence: **CLI flags > environment variables > config file > defaults.**

| Setting  | Flag              | Env var                | Config file key | Default                            |
| -------- | ----------------- | ---------------------- | --------------- | ---------------------------------- |
| Port     | `-p, --port`      | `COPILOT2API_PORT`     | `port`          | `4141`                             |
| Host     | `--host`          | `COPILOT2API_HOST`     | `host`          | `127.0.0.1`                        |
| API key  | `--api-key`       | `COPILOT2API_API_KEY`  | `apiKey`        | _(none — no auth)_                 |
| Config   | `-c, --config`    | —                      | —               | `~/.config/copilot2api/config.json` |

Example config file (`~/.config/copilot2api/config.json`):

```json
{
  "port": 4141,
  "apiKey": "my-local-secret"
}
```

When an API key is set, `/v1` routes require `Authorization: Bearer <key>`.

## Notes & limitations

- **Local by design.** Binds to `127.0.0.1` by default; the server fronts your
  personal Copilot login, so treat it like a credential.
- **Chat-only bridge.** Copilot's agent tools are disabled and permission
  requests are rejected — it behaves as a pure model endpoint.
- Each request runs in a fresh SDK session; the OpenAI message history is
  rendered into a single transcript prompt.
- Available models are governed by your Copilot plan/org policy (you may only
  see `auto`).
- `usage` token counts are not reported by the SDK and are returned as zeros.
- Requires an active GitHub Copilot subscription. Use of Copilot through this
  tool is subject to [GitHub's terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
  and your organization's policies — check before deploying beyond personal use.

## Development

```sh
git clone https://github.com/asllani94/copilot2api
cd copilot2api
npm install
npm start
```

## License

[MIT](LICENSE)
