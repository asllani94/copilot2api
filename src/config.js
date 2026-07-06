/**
 * Configuration resolution, highest precedence first:
 *
 *   1. CLI flags            (--port, --host, --api-key, ...)
 *   2. Environment          (COPILOT2API_PORT, COPILOT2API_HOST, ...)
 *   3. Config file          (--config <path>, or ~/.config/copilot2api/config.json)
 *   4. Built-in defaults
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = Object.freeze({
  /** Loopback by default: this server fronts a personal Copilot login. */
  host: "127.0.0.1",
  port: 4141,
  /** No auth by default; set to require `Authorization: Bearer <key>`. */
  apiKey: undefined,
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: 10 * 1024 * 1024,
});

export function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "copilot2api", "config.json");
}

/**
 * @param {object} flags Parsed CLI flags (`port`, `host`, `apiKey`, `config`).
 * @returns {{host: string, port: number, apiKey: string|undefined, maxBodyBytes: number}}
 */
export function resolveConfig(flags = {}) {
  const file = readConfigFile(flags.config);
  const env = process.env;

  return Object.freeze({
    host: flags.host ?? env.COPILOT2API_HOST ?? file.host ?? DEFAULTS.host,
    port: parsePort(flags.port ?? env.COPILOT2API_PORT ?? file.port ?? DEFAULTS.port),
    apiKey: flags["api-key"] ?? env.COPILOT2API_API_KEY ?? file.apiKey ?? DEFAULTS.apiKey,
    maxBodyBytes: parseSize(
      env.COPILOT2API_MAX_BODY_BYTES ?? file.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    ),
  });
}

/**
 * Read the config file. An explicitly passed path must exist; the default
 * path is optional.
 */
function readConfigFile(explicitPath) {
  const filePath = explicitPath ?? defaultConfigPath();
  if (!fs.existsSync(filePath)) {
    if (explicitPath) throw new Error(`Config file not found: ${explicitPath}`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse config file ${filePath}: ${err.message}`);
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size in bytes: ${value}`);
  }
  return size;
}
