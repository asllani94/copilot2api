#!/usr/bin/env node
/**
 * copilot2api — OpenAI-compatible local API server for GitHub Copilot.
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createAdapter } from "../src/adapters/index.js";
import { createApp } from "../src/app.js";
import { defaultConfigPath, DEFAULTS, resolveConfig } from "../src/config.js";

const pkg = createRequire(import.meta.url)("../package.json");

const HELP = `copilot2api ${pkg.version}
OpenAI- and Anthropic-compatible local API server for GitHub Copilot or Microsoft 365 Copilot.

Usage:
  copilot2api [options]

Options:
  -p, --port <port>     Port to listen on (default: ${DEFAULTS.port})
      --host <host>     Interface to bind (default: ${DEFAULTS.host})
      --mode <mode>     Backend: "copilot" (default) or "m365"
      --api-key <key>   Require the key ("Authorization: Bearer" or "x-api-key") on API routes
  -c, --config <path>   Config file (default: ${defaultConfigPath()})
  -h, --help            Show this help
  -v, --version         Show version

Configuration precedence: CLI flags > environment > config file > defaults.
Environment variables: COPILOT2API_MODE, COPILOT2API_PORT, COPILOT2API_HOST, COPILOT2API_API_KEY.
Config file format: JSON with { "mode", "port", "host", "apiKey", "modelMap", "m365" }.

Authentication:
  copilot mode (default):
    Uses your GitHub Copilot login (device flow). To sign in, run:
      copilot2api login
  m365 mode:
    Supply a Microsoft 365 substrate access token — never a login flow here.
    Set COPILOT2API_M365_TOKEN (or "m365": { "token": ... } in the config file).
    The token is sent only to substrate.office.com and never to the model.
`;

main().catch((err) => {
  console.error(`copilot2api: ${err?.message ?? err}`);
  process.exit(1);
});

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      mode: { type: "string" },
      "api-key": { type: "string" },
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(pkg.version);
  if (positionals[0] === "login" || positionals[0] === "logout") {
    // Auth commands only apply to the GitHub Copilot device flow. M365 mode
    // has no login here — it takes a pre-issued token via env/config.
    return runCopilotCli(positionals);
  }
  if (positionals.length > 0) {
    throw new Error(`Unknown command '${positionals[0]}'. See: copilot2api --help`);
  }

  const config = resolveConfig(values);
  await startServer(config);
}

async function startServer(config) {
  const adapter = await createAdapter(config);

  const server = serve(
    { fetch: createApp(adapter, config).fetch, port: config.port, hostname: config.host },
    (info) => {
      console.log(
        `copilot2api ${pkg.version} (${config.mode} mode) listening on http://${info.address}:${info.port}/v1`,
      );
      if (config.mode === "m365") {
        console.log("M365 mode: access token read from config/env; sent only to substrate.office.com.");
      }
      if (!config.apiKey) console.log("No API key configured; accepting unauthenticated requests.");
      // Only guard against stray async errors once startup has succeeded —
      // startup failures (e.g. EADDRINUSE) must stay fatal.
      installProcessGuards();
    },
  );

  server.on("error", (err) => {
    console.error(`copilot2api: failed to start server: ${err.message}`);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    try {
      await adapter.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Delegate auth commands to the Copilot CLI bundled with the SDK. */
async function runCopilotCli(args) {
  const { spawn } = await import("node:child_process");
  const require = createRequire(import.meta.url);
  const cliBin = require.resolve("@github/copilot/npm-loader.js");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : process.exit(code ?? 1)));
    child.on("error", reject);
  });
}

/** Don't let a stray SDK/subprocess error take the whole server down. */
function installProcessGuards() {
  process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
  process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
}
