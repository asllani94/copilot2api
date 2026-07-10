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
  /** Backend: "copilot" (GitHub Copilot, default) or "m365" (Microsoft 365 Copilot). */
  mode: "copilot",
  /** Loopback by default: this server fronts a personal Copilot login. */
  host: "127.0.0.1",
  port: 4141,
  /** No auth by default; set to require `Authorization: Bearer <key>`. */
  apiKey: undefined,
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: 10 * 1024 * 1024,
  /**
   * Display-ID → Copilot-ID model aliases, e.g. {"claude-sonnet-4": "auto"}.
   * Aliased IDs are accepted in requests and listed by /v1/models.
   */
  modelMap: {},
});

export function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "copilot2api", "config.json");
}

/**
 * @param {object} flags Parsed CLI flags (`port`, `host`, `apiKey`, `config`).
 * @returns {{host: string, port: number, apiKey: string|undefined, maxBodyBytes: number, modelMap: Record<string, string>}}
 */
export function resolveConfig(flags = {}) {
  const file = readConfigFile(flags.config);
  const env = process.env;

  return Object.freeze({
    mode: parseMode(flags.mode ?? env.COPILOT2API_MODE ?? file.mode ?? DEFAULTS.mode),
    host: flags.host ?? env.COPILOT2API_HOST ?? file.host ?? DEFAULTS.host,
    port: parsePort(flags.port ?? env.COPILOT2API_PORT ?? file.port ?? DEFAULTS.port),
    apiKey: flags["api-key"] ?? env.COPILOT2API_API_KEY ?? file.apiKey ?? DEFAULTS.apiKey,
    maxBodyBytes: parseSize(
      env.COPILOT2API_MAX_BODY_BYTES ?? file.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    ),
    modelMap: parseModelMap(file.modelMap ?? DEFAULTS.modelMap),
    m365: resolveM365(file.m365 ?? {}, env),
  });
}

/**
 * Resolve Microsoft 365 Copilot settings. The access token is deliberately
 * accepted only via environment variable or config file — never a CLI flag —
 * so it does not leak into shell history or the process list. `tenantId` and
 * `userOid` are optional; when omitted they are read from the token's claims.
 */
function resolveM365(file, env) {
  return Object.freeze({
    token: env.COPILOT2API_M365_TOKEN ?? env.M365_COPILOT_TOKEN ?? file.token,
    tenantId: env.COPILOT2API_M365_TENANT_ID ?? env.M365_TENANT_ID ?? file.tenantId,
    userOid: env.COPILOT2API_M365_USER_OID ?? env.M365_USER_OID ?? file.userOid,
  });
}

function parseMode(value) {
  if (value !== "copilot" && value !== "m365") {
    throw new Error(`Invalid mode: ${value} (expected "copilot" or "m365")`);
  }
  return value;
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

function parseModelMap(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid modelMap: expected an object of {displayId: copilotId} strings");
  }
  for (const [display, copilot] of Object.entries(value)) {
    if (typeof copilot !== "string" || !copilot) {
      throw new Error(`Invalid modelMap entry for '${display}': expected a model id string`);
    }
  }
  return Object.freeze({ ...value });
}

function parseSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size in bytes: ${value}`);
  }
  return size;
}
