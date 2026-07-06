import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULTS, defaultConfigPath, resolveConfig } from "../src/config.js";

const ENV_KEYS = [
  "COPILOT2API_HOST",
  "COPILOT2API_PORT",
  "COPILOT2API_API_KEY",
  "COPILOT2API_MAX_BODY_BYTES",
  "XDG_CONFIG_HOME",
];

describe("resolveConfig", () => {
  let saved;
  let tmpDir;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    // Point the default config location at an empty temp dir so a config
    // file on the developer's machine can't leak into the tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot2api-test-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeConfigFile = (contents) => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(file, JSON.stringify(contents));
    return file;
  };

  it("uses defaults when nothing is configured", () => {
    const config = resolveConfig();
    assert.equal(config.host, DEFAULTS.host);
    assert.equal(config.port, DEFAULTS.port);
    assert.equal(config.apiKey, undefined);
  });

  it("reads the default config file location from XDG_CONFIG_HOME", () => {
    const dir = path.join(tmpDir, "copilot2api");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 5000 }));
    assert.equal(defaultConfigPath(), path.join(dir, "config.json"));
    assert.equal(resolveConfig().port, 5000);
  });

  it("config file beats defaults", () => {
    const file = writeConfigFile({ port: 5001, apiKey: "from-file" });
    const config = resolveConfig({ config: file });
    assert.equal(config.port, 5001);
    assert.equal(config.apiKey, "from-file");
  });

  it("environment beats config file", () => {
    const file = writeConfigFile({ port: 5001 });
    process.env.COPILOT2API_PORT = "5002";
    assert.equal(resolveConfig({ config: file }).port, 5002);
  });

  it("flags beat environment", () => {
    process.env.COPILOT2API_PORT = "5002";
    assert.equal(resolveConfig({ port: "5003" }).port, 5003);
  });

  it("rejects an invalid port", () => {
    assert.throws(() => resolveConfig({ port: "banana" }), /Invalid port/);
    assert.throws(() => resolveConfig({ port: "70000" }), /Invalid port/);
  });

  it("rejects a missing explicit config file", () => {
    assert.throws(() => resolveConfig({ config: "/nonexistent.json" }), /not found/);
  });

  it("rejects an unparseable config file", () => {
    const file = path.join(tmpDir, "bad.json");
    fs.writeFileSync(file, "{nope");
    assert.throws(() => resolveConfig({ config: file }), /Failed to parse/);
  });
});
