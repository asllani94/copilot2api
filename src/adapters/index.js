/**
 * Adapter factory: build the backend adapter for the configured mode.
 *
 * An adapter exposes a small, backend-agnostic interface:
 *   adapter.mode                       // "copilot" | "m365"
 *   adapter.listModels()               // → Array<{ id }>
 *   adapter.createChatSession(opts)    // → session (see ../session.js)
 *   adapter.stop()                     // release backend resources
 *
 * The GitHub Copilot SDK is imported lazily so M365-only deployments do not
 * need it installed or a Copilot login present.
 */
import { copilotAdapter } from "./copilot.js";
import { m365Adapter } from "./m365/index.js";

/**
 * @param {import("../config.js").resolveConfig extends (...a: any) => infer R ? R : never} config
 */
export async function createAdapter(config) {
  if (config.mode === "m365") {
    return m365Adapter(config.m365);
  }

  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient();
  await client.start();
  return copilotAdapter(client);
}
