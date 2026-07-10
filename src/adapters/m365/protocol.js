/**
 * The M365 Copilot ("Bizchat"/Sydney) wire protocol: SignalR-over-WebSocket
 * against substrate.office.com.
 *
 * This is a private protocol, reconstructed from the browser client. The URL
 * construction, feature flags, option sets, and chat payload below are kept
 * 1:1 with the reference implementation (HEXUXIU/M365-Copilot2API,
 * `payload.py`) so the substrate backend serves the exact behaviour it serves
 * that client. Frames are JSON objects delimited by the ASCII record separator
 * (0x1E). The chat request is a SignalR StreamInvocation (message type 4); the
 * server replies with a stream of "update" invocations (type 1) and a final
 * completion (type 3).
 */
import crypto from "node:crypto";

/** ASCII record separator that terminates every SignalR frame. */
export const RS = "\x1e";

/** SignalR message types we care about. */
export const FRAME = Object.freeze({
  INVOCATION: 1, // server → client streaming "update"
  COMPLETION: 3, // server → client end-of-turn
  STREAM_INVOCATION: 4, // client → server chat request
  ERROR: -1, // reference's error signal
});

/** The JSON handshake sent immediately after the socket opens. */
export const HANDSHAKE_REQUEST = { protocol: "json", version: 1 };

/** Matches the reference `websockets.connect(..., max_size=50MB, ...)`. */
export const MAX_PAYLOAD = 50 * 1024 * 1024;

const SUBSTRATE_WS_BASE = "wss://substrate.office.com/m365Copilot/Chathub";

/**
 * Feature flags the browser client sends, verbatim from the reference
 * `VARIANTS`. Comma-joined and appended to the URL unencoded, as the backend
 * expects.
 */
const VARIANTS =
  "EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin," +
  "EnableRequestPlugins,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3," +
  "feature.enablechatpages,feature.IsStreamingModeInChatEnabled," +
  "IncludeSourceAttributionsConcise,SkipPublishEmptyMessage," +
  "feature.EnableDeduplicatingSourceAttributions,feature.enableDeltaStreamingForReferences," +
  "feature.enableIncludeReferencesInDeltaResponse,feature.enablereferencesforagents," +
  "feature.EnableReferencesListCompleteSignal,SingletonEnvOn,cdxenablefccinmainline," +
  "feature.disabledisallowedmsgs,cdximagen,cdxenablerenderforisocomp," +
  "feature.EnablePersonalization,feature.EnableSkipEmittingMessageOnFlush," +
  "feature.EnableRemoveEmptySourceAttributions,feature.EnableRemoveStreamingMode," +
  "feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix," +
  "feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix," +
  "feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix";

/** Response message types the client declares it can render (reference `ALLOWED_MSG_TYPES`). */
const ALLOWED_MESSAGE_TYPES = [
  "Chat",
  "Suggestion",
  "InternalSearchQuery",
  "Disengaged",
  "InternalLoaderMessage",
  "Progress",
  "GeneratedCode",
  "RenderCardRequest",
  "AdsQuery",
  "SemanticSerp",
  "GenerateContentQuery",
  "GenerateGraphicArt",
  "SearchQuery",
  "ConfirmationCard",
  "AuthError",
  "DeveloperLogs",
  "TriggerPlugin",
  "HintInvocation",
  "MemoryUpdate",
  "EndOfRequest",
  "TriggerConfirmation",
  "ResumeInvokeAction",
  "ResumeUserInputRequest",
];

/** Full option set (reference `OPTIONS_SETS_FULL`). */
const OPTIONS_SETS_FULL = [
  "search_result_progress_messages_with_search_queries",
  "update_textdoc_response_after_streaming",
  "deepleo_networking_timeout_10minutes_canmore",
  "cwc_flux_image",
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwcfluxgptv",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "cwc_code_interpreter_interactive_charts_inline_image",
  "code_interpreter_matplotlib_patching",
  "cwc_fileupload_odb",
  "update_memory_plugin",
  "add_custom_instructions",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "enable_batch_token_processing",
  "enable_gg_gpt",
  "flux_v3_references",
  "flux_v3_references_entities",
  "flux_v3_image_gen_enable_dimensions",
  "flux_v3_image_gen_enable_non_watermarked_storage",
  "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_system_text_with_params",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_story",
  "rich_responses",
  "pages_citations",
  "pages_citations_multiturn",
];

/** Option subsets removed when image generation / file upload are disabled. */
const IMAGE_OPTIONS = new Set([
  "cwc_flux_image",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "flux_v3_references",
  "flux_v3_references_entities",
  "flux_v3_image_gen_enable_dimensions",
  "flux_v3_image_gen_enable_non_watermarked_storage",
  "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_system_text_with_params",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_story",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
]);
const FILE_UPLOAD_OPTIONS = new Set(["cwc_fileupload_odb"]);

/**
 * Option set for a text-only turn (reference `OPTIONS_SETS_FULL_NO_IMG_FILE`):
 * the full set minus image-generation and file-upload options.
 */
function optionSets({ enableImageGen = false, enableFileUpload = false } = {}) {
  return OPTIONS_SETS_FULL.filter((o) => {
    if (!enableImageGen && IMAGE_OPTIONS.has(o)) return false;
    if (!enableFileUpload && FILE_UPLOAD_OPTIONS.has(o)) return false;
    return true;
  });
}

/**
 * Built-in "models" exposed to callers. M365 Copilot does not let you pick a
 * raw model; it exposes conversation *tones*, so each id here maps to a tone
 * (reference `MODELS`).
 */
export const M365_MODELS = Object.freeze([
  { id: "auto", tone: "Magic" },
  { id: "quick", tone: "Chat" },
  { id: "reasoning", tone: "Reasoning" },
]);

/** Resolve a requested model id to a tone, defaulting to `auto`/Magic. */
export function toneForModel(model) {
  const match = M365_MODELS.find((m) => m.id === model);
  return match ? match.tone : "Magic";
}

/** Serialize one frame object for the wire (JSON + record separator). */
export function encodeFrame(obj) {
  return JSON.stringify(obj) + RS;
}

/** Split a raw WebSocket payload into parsed frame objects, skipping junk. */
export function decodeFrames(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const frames = [];
  for (const part of text.split(RS)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      frames.push(JSON.parse(trimmed));
    } catch {
      // Partial or non-JSON control frame; ignore.
    }
  }
  return frames;
}

/** Fresh per-connection session identifiers (hex form and dashed UUID form). */
export function newSessionIds() {
  const hex = crypto.randomUUID().replace(/-/g, "");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return { hex, uuid };
}

/**
 * Build the authenticated WebSocket URL, 1:1 with the reference `build_url`
 * (parameter names, order, and encoding). The access token is carried as a
 * query parameter because that is how the substrate SignalR endpoint
 * authenticates the upgrade — it is sent only to substrate.office.com, the
 * service that issued it. Callers must redact this URL before logging it.
 *
 * @param {{ userOid: string, tenantId: string, token: string, session: {hex: string, uuid: string}, conversationId?: string }} args
 */
export function buildWsUrl({ userOid, tenantId, token, session, conversationId }) {
  if (!userOid || !tenantId) {
    throw new Error("M365 requires a user OID and tenant ID (from the token, config, or env)");
  }
  let url = `${SUBSTRATE_WS_BASE}/${userOid}@${tenantId}`;
  url += `?chatsessionid=${session.hex}&XRoutingParameterSessionKey=${session.hex}`;
  url += `&clientrequestid=${session.hex}&X-SessionId=${session.uuid}`;
  if (conversationId) url += `&ConversationId=${conversationId}`;
  url += `&access_token=${token}`;
  url += `&variants=${VARIANTS}`;
  url += "&source=%22officeweb%22&product=Office&agentHost=Bizchat.FullScreen";
  url += "&licenseType=Starter&isEdu=false&agent=web&scenario=OfficeWebIncludedCopilot";
  return url;
}

/**
 * Build the SignalR StreamInvocation (type 4) that submits a chat turn, 1:1
 * with the reference `build_payload`. The `text` is the only user content sent
 * to the model; credentials are never placed here.
 *
 * @param {{ session: {hex: string, uuid: string}, text: string, tone?: string, gptOverride?: string, enableImageGen?: boolean, enableFileUpload?: boolean }} args
 */
export function buildChatInvocation({
  session,
  text,
  tone = "Magic",
  gptOverride = null,
  enableImageGen = false,
  enableFileUpload = false,
}) {
  const { offset, timeZone, locale } = localeInfo();
  const invocation = {
    type: FRAME.STREAM_INVOCATION,
    invocationId: crypto.randomUUID(),
    target: "chat",
    arguments: [
      {
        source: "officeweb",
        clientCorrelationId: session.hex,
        sessionId: session.uuid,
        message: {
          author: "user",
          inputMethod: "Keyboard",
          text,
          entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
          requestId: `${session.hex}_0`,
          locationInfo: { timeZoneOffset: offset, timeZone },
          locale,
          messageType: "Chat",
          experienceType: "Default",
          adaptiveCards: [],
          clientPreferences: {},
          connectedFederatedConnections: ["dummyId"],
        },
        optionsSets: optionSets({ enableImageGen, enableFileUpload }),
        streamingMode: "ConciseWithPadding",
        spokenTextMode: "None",
        options: {},
        extraExtensionParameters: {},
        allowedMessageTypes: ALLOWED_MESSAGE_TYPES,
        sliceIds: [],
        tone,
        plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }],
        isStartOfSession: false,
        isSbsSupported: true,
        renderReferencesBehindEOS: true,
        disconnectBehavior: "continue",
      },
    ],
  };
  if (gptOverride) {
    invocation.arguments[0].gptIdOverride = { id: gptOverride, source: "MOS3" };
  }
  return invocation;
}

/**
 * Apply a server "update" frame (type 1, target "update"), 1:1 with the
 * reference stream loop: for each argument, emit incremental `writeAtCursor`
 * chunks and the new suffix of the cumulative `messages[-1].text`.
 *
 * `previousText` is the assistant text emitted so far. Returns the list of new
 * delta strings and the updated cumulative text.
 *
 * @param {object} frame
 * @param {string} previousText
 * @returns {{ deltas: string[], text: string }}
 */
export function applyUpdateFrame(frame, previousText) {
  let text = previousText;
  const deltas = [];
  if (frame?.type !== FRAME.INVOCATION || frame.target !== "update") return { deltas, text };
  for (const arg of frame.arguments ?? []) {
    const messages = Array.isArray(arg?.messages) ? arg.messages : [];
    if (messages.length > 0) {
      const newText = messages[messages.length - 1]?.text;
      if (typeof newText === "string" && newText && newText !== text) {
        const chunk = newText.startsWith(text) ? newText.slice(text.length) : newText;
        text = newText;
        if (chunk) deltas.push(chunk);
      }
    }
    if (typeof arg?.writeAtCursor === "string" && arg.writeAtCursor) {
      text += arg.writeAtCursor;
      deltas.push(arg.writeAtCursor);
    }
  }
  return { deltas, text };
}

/** Strip control characters and citation markers from an assembled reply. */
export function cleanText(text) {
  if (!text) return "";
  return text
    // Private-use-area citation runs the web UI renders as footnotes
    // (reference `_clean_citations`).
    .replace(/\s*[-]cite[-](?:[^-]+[-])+[^-]*/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/g, "")
    .trim();
}

function localeInfo() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    offset: -Math.round(new Date().getTimezoneOffset() / 60),
    timeZone: resolved.timeZone || "UTC",
    locale: resolved.locale || "en-US",
  };
}
