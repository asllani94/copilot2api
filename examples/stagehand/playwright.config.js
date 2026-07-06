import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // LLM round-trips through Copilot are slow; give each test room.
  timeout: 180_000,
  // One Stagehand browser at a time.
  workers: 1,
  fullyParallel: false,
  use: {
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
