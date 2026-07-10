/**
 * Hono application: routes, middleware, and OpenAI/Anthropic <-> Copilot bridging.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import {
  countTokens,
  MessagesStream,
  parseMessagesRequest,
  toAnthropicError,
  toMessagesResponse,
} from "./anthropic.js";
import { disconnectQuietly, runToCompletion } from "./session.js";
import { ApiError } from "./errors.js";
import {
  completionMeta,
  renderChat,
  toChatCompletion,
  toChunk,
  toErrorBody,
  toModelList,
  toolCallDelta,
} from "./openai.js";
import { parseResponsesRequest, toResponse } from "./responses.js";
import { parseToolCalls, ToolCallParser } from "./toolcalls.js";

/**
 * @param {import("./adapters/index.js").createAdapter extends (...a: any) => Promise<infer R> ? R : never} adapter
 * @param {import("./config.js").resolveConfig extends (...a: any) => infer R ? R : never} config
 */
export function createApp(adapter, config) {
  const app = new Hono();
  const modelMap = config.modelMap ?? {};
  /** Translate a configured display/alias ID to its Copilot model ID. */
  const resolveModel = (model) => modelMap[model] ?? model;
  /** Anthropic routes get Anthropic-shaped error envelopes. */
  const errorShape = (c, message, type) =>
    c.req.path.startsWith("/v1/messages") ? toAnthropicError(message, type) : toErrorBody(message, type);

  if (config.logRequests !== false) app.use(logger());
  app.use(
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version", "anthropic-beta"],
    }),
  );
  app.use(
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) =>
        c.json(errorShape(c, `Request body exceeds ${config.maxBodyBytes} bytes`), 413),
    }),
  );
  if (config.apiKey) {
    // Accept the key as `Authorization: Bearer` (OpenAI style) or
    // `x-api-key` (Anthropic style).
    const requireKey = async (c, next) => {
      const authorization = c.req.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      if ((bearer ?? c.req.header("x-api-key")) !== config.apiKey) {
        return c.json(errorShape(c, "Invalid API key", "authentication_error"), 401);
      }
      await next();
    };
    for (const path of ["/v1/*", "/chat/*", "/models"]) app.use(path, requireKey);
  }

  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.on("GET", ["/v1/models", "/models"], async (c) =>
    c.json(toModelList(await adapter.listModels())),
  );

  app.on("POST", ["/v1/chat/completions", "/chat/completions"], async (c) => {
    const request = parseChatRequest(await parseJson(c));
    const session = await adapter.createChatSession({
      model: resolveModel(request.model),
      stream: request.stream,
      system: request.system,
    });

    if (!request.stream) {
      const content = await runToCompletion(session, request.prompt);
      return c.json(toChatCompletion(completionMeta(request.model), parseToolCalls(content)));
    }
    return streamCompletion(c, session, request);
  });

  app.post("/v1/responses", async (c) => {
    const request = parseResponsesRequest(await parseJson(c));
    const session = await adapter.createChatSession({
      model: resolveModel(request.model),
      stream: false,
      system: request.system,
    });
    const reply = await runToCompletion(session, request.prompt);
    return c.json(toResponse(request, reply));
  });

  app.post("/v1/messages", async (c) => {
    const request = parseMessagesRequest(await parseJson(c));
    const session = await adapter.createChatSession({
      model: resolveModel(request.model),
      stream: request.stream,
      system: request.system,
    });

    if (!request.stream) {
      const content = await runToCompletion(session, request.prompt);
      return c.json(toMessagesResponse(request.model, parseToolCalls(content)));
    }
    return streamMessages(c, session, request);
  });

  app.post("/v1/messages/count_tokens", async (c) => c.json(countTokens(await parseJson(c))));

  app.notFound((c) => c.json(errorShape(c, `Unknown route: ${c.req.method} ${c.req.path}`), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorShape(c, err.message, err.type), err.status);
    }
    console.error(err);
    return c.json(errorShape(c, String(err?.message ?? err), "server_error"), 500);
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
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((t) => t?.type === "function" && t.function?.name).map((t) => t.function)
    : [];
  const { system, prompt } = renderChat(messages, tools);
  return { model, stream: Boolean(stream), system, prompt };
}

/**
 * Drive a session and settle when the turn ends. `onDelta` receives text
 * deltas, `onIdle` runs once the session goes idle, `onFailure` receives an
 * error message. The returned promise resolves after any of them completes.
 */
function driveSession(session, prompt, stream, { onDelta, onIdle, onFailure }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    session.on("assistant.message_delta", (event) => {
      const text = event.data.deltaContent;
      if (text) onDelta(text);
    });
    session.on("session.idle", async () => {
      await onIdle();
      settle();
    });
    session.on("session.error", async (event) => {
      await onFailure(event.data?.message ?? "Copilot session error");
      settle();
    });

    // Client hung up mid-stream: abort the in-flight turn instead of finishing it.
    stream.onAbort(async () => {
      await session.abort().catch(() => {});
      settle();
    });

    session.send({ prompt }).catch(async (err) => {
      await onFailure(String(err?.message ?? err));
      settle();
    });
  });
}

function streamCompletion(c, session, { model, prompt }) {
  const meta = completionMeta(model);
  const parser = new ToolCallParser();

  return streamSSE(c, async (stream) => {
    const send = (payload) => stream.writeSSE({ data: JSON.stringify(payload) });
    await send(toChunk(meta, { role: "assistant", content: "" }));

    const onText = (text) => send(toChunk(meta, { content: text }));
    const onToolCall = (index, id, name, args) =>
      send(toChunk(meta, toolCallDelta(index, id, name, args)));

    await driveSession(session, prompt, stream, {
      onDelta: (text) => parser.feed(text, onText, onToolCall),
      onIdle: async () => {
        parser.flush(onText, onToolCall);
        await send(toChunk(meta, {}, parser.sawToolCall ? "tool_calls" : "stop"));
        await stream.writeSSE({ data: "[DONE]" });
      },
      onFailure: (message) => send(toErrorBody(message, "server_error")),
    });

    await disconnectQuietly(session);
  });
}

function streamMessages(c, session, { model, prompt }) {
  const state = new MessagesStream(model);
  const parser = new ToolCallParser();

  return streamSSE(c, async (stream) => {
    const write = ({ event, data }) => stream.writeSSE({ event, data: JSON.stringify(data) });
    const emit = (events) => {
      for (const e of events) write(e);
    };
    emit(state.start());

    const onText = (text) => emit(state.text(text));
    const onToolCall = (index, id, name, args) => emit(state.toolCall(id, name, args));

    await driveSession(session, prompt, stream, {
      onDelta: (text) => parser.feed(text, onText, onToolCall),
      onIdle: () => {
        parser.flush(onText, onToolCall);
        emit(state.finish(parser.sawToolCall ? "tool_use" : "end_turn"));
      },
      onFailure: (message) => write({ event: "error", data: toAnthropicError(message, "api_error") }),
    });

    await disconnectQuietly(session);
  });
}
