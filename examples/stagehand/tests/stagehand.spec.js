/**
 * Stagehand browser automation driven entirely by copilot2api.
 *
 * Stagehand's LLM calls are pointed at the local copilot2api server
 * (OpenAI Responses API), which bridges them to GitHub Copilot.
 *
 * Prerequisite: copilot2api running locally (default http://127.0.0.1:4141).
 */
import { test, expect } from "@playwright/test";
import { Stagehand } from "@browserbasehq/stagehand";

const COPILOT2API_URL = process.env.COPILOT2API_URL ?? "http://127.0.0.1:4141/v1";
const MODEL = process.env.COPILOT2API_MODEL ?? "auto";

let stagehand;
let page;

test.beforeAll(async () => {
  stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    model: {
      modelName: `openai/${MODEL}`,
      baseURL: COPILOT2API_URL,
      apiKey: process.env.COPILOT2API_API_KEY ?? "unused",
    },
    localBrowserLaunchOptions: { headless: true },
  });
  await stagehand.init();
  page = stagehand.context.activePage() ?? (await stagehand.context.newPage());
});

test.afterAll(async () => {
  await stagehand?.close({ force: true });
});

test("extract: reads the main heading from example.com", async () => {
  await page.goto("https://example.com");
  const { extraction } = await stagehand.extract("the main heading text on the page");
  expect(extraction.toLowerCase()).toContain("example");
});

test("observe: finds the 'Learn more' link", async () => {
  await page.goto("https://example.com");
  const actions = await stagehand.observe("the 'Learn more' link");
  expect(actions.length).toBeGreaterThan(0);
  expect(JSON.stringify(actions).toLowerCase()).toContain("learn more");
});

test("act: clicks through to iana.org", async () => {
  await page.goto("https://example.com");
  await stagehand.act("click the 'Learn more' link");
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("iana.org");
});
