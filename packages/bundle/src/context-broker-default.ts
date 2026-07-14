import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function contextBrokerEnabled(): boolean {
  return !DISABLED_VALUES.has(String(process.env.PI_CONTEXT_BROKER_ENABLED ?? "").trim().toLowerCase());
}

export async function registerDefaultContextBroker(pi: ExtensionAPI): Promise<void> {
  if (!contextBrokerEnabled()) return;
  const p = pi as any;
  try {
    const { registerContextBrokerBeta } = await import("@fiale-plus/pi-rogue-context-broker/extension");
    const durableEnv = String(process.env.PI_CONTEXT_BROKER_DURABLE ?? "").trim().toLowerCase();
    const durable = !DISABLED_VALUES.has(durableEnv);
    const configuredStoreDir = String(process.env.PI_CONTEXT_BROKER_STORE_DIR ?? "").trim();
    await registerContextBrokerBeta(pi, {
      durable,
      storeDir: configuredStoreDir || join(homedir(), ".pi", "agent", "pi-rogue", "context-broker"),
    });
  } catch (error) {
    p.__piRogueContextBrokerError = error;
    console.warn("[pi-rogue] context broker registration failed; continuing without /pi-rogue-context", error);
  }
}
