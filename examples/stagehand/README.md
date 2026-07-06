# Stagehand + Playwright example

AI browser automation with [Stagehand](https://github.com/browserbase/stagehand),
where every LLM call is served by **copilot2api** — i.e. your GitHub Copilot
subscription drives the browser.

Stagehand talks to copilot2api through the OpenAI **Responses API**
(`POST /v1/responses`), including structured JSON output (`extract`, `act`)
and prompt-shimmed function calling.

## Run

```sh
# 1. Start copilot2api (from the repo root, or `npm i -g copilot2api`)
copilot2api

# 2. Install and run the tests (first time: also downloads Chromium)
cd examples/stagehand
npm install
npx playwright install chromium
npm test
```

## Configuration

| Env var               | Default                    | Description                 |
| --------------------- | -------------------------- | --------------------------- |
| `COPILOT2API_URL`     | `http://127.0.0.1:4141/v1` | Where copilot2api listens   |
| `COPILOT2API_MODEL`   | `auto`                     | Model to request            |
| `COPILOT2API_API_KEY` | `unused`                   | Only needed if the server is started with `--api-key` |

## What the tests do

1. **extract** — reads the main heading of example.com via structured JSON output
2. **observe** — locates the "Learn more" link from the accessibility tree
3. **act** — clicks the link and asserts navigation to iana.org
