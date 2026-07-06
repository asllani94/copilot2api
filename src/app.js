/**
 * Hono application: routes, middleware, and OpenAI <-> Copilot bridging.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { createChatSession, disconnectQuietly, runToCompletion } from "./copilot.js";
import { ApiError } from "./errors.js";
import {
  completionMeta,
  renderPrompt,
  toChatCompletion,
  toChunk,
  toErrorBody,
  toModelList,
} from "./openai.js";

/**
 * @param {import("@github/copilot-sdk").CopilotClient} client
 * @param {import("./config.js").resolveConfig extends (...a: any) => infer R ? R : never} config
 */
export function createApp(client, config) {
  const app = new Hono();

  if (config.logRequests !== false) app.use(logger());
  app.use(cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"] }));
  app.use(
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) =>
        c.json(toErrorBody(`Request body exceeds ${config.maxBodyBytes} bytes`), 413),
    }),
  );
  if (config.apiKey) {
    app.use("/v1/*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${config.apiKey}`) {
        return c.json(toErrorBody("Invalid API key", "authentication_error"), 401);
      }
      await next();
    });
  }

  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/v1/models", async (c) => c.json(toModelList(await client.listModels())));

  app.post("/v1/chat/completions", async (c) => {
    const request = parseChatRequest(await parseJson(c));
    const session = await createChatSession(client, request);

    if (!request.stream) {
      const content = await runToCompletion(session, request.prompt);
      return c.json(toChatCompletion(completionMeta(request.model), content));
    }
    return streamCompletion(c, session, request);
  });

  app.notFound((c) => c.json(toErrorBody(`Unknown route: ${c.req.method} ${c.req.path}`), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(toErrorBody(err.message, err.type), err.status);
    }
    console.error(err);
    return c.json(toErrorBody(String(err?.message ?? err), "server_error"), 500);
  });

  return app;
}

async function parseJson(c) {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

function parseChatRequest(body) {
  const { model, messages, stream = false } = body;
  if (!model) throw new ApiError(400, "'model' is required");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "'messages' must be a non-empty array");
  }
  return { model, stream: Boolean(stream), prompt: renderPrompt(messages) };
}

function streamCompletion(c, session, { model, prompt }) {
  const meta = completionMeta(model);

  return streamSSE(c, async (stream) => {
    const send = (payload) => stream.writeSSE({ data: JSON.stringify(payload) });
    await send(toChunk(meta, { role: "assistant", content: "" }));

    await new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      session.on("assistant.message_delta", (event) => {
        const text = event.data.deltaContent;
        if (text) send(toChunk(meta, { content: text }));
      });
      session.on("session.idle", async () => {
        await send(toChunk(meta, {}, "stop"));
        await stream.writeSSE({ data: "[DONE]" });
        settle();
      });
      session.on("session.error", async (event) => {
        await send(toErrorBody(event.data?.message ?? "Copilot session error", "server_error"));
        settle();
      });

      // Client hung up mid-stream: abort the in-flight turn instead of finishing it.
      stream.onAbort(async () => {
        await session.abort().catch(() => {});
        settle();
      });

      session.send({ prompt }).catch(async (err) => {
        await send(toErrorBody(String(err?.message ?? err), "server_error"));
        settle();
      });
    });

    await disconnectQuietly(session);
  });
}
