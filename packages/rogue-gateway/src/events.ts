import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventRecord } from "./types.js";

const DEFAULT_EVENT_SCHEMA = "pi-rogue-gateway.event.v1" as const;

export const GATEWAY_EVENT_SCHEMA = DEFAULT_EVENT_SCHEMA;

let counter = 0;

export function newEventId(prefix = "evt"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${String(counter).padStart(4, "0")}`;
}

export function appendEvent(path: string, event: Omit<EventRecord, "eventId" | "timestamp">): EventRecord {
  const resolved = resolve(path);
  const nowIso = new Date().toISOString();
  const stamped: EventRecord = {
    eventId: newEventId(),
    timestamp: nowIso,
    ...event,
    data: { ...event.data },
  };

  const payload = {
    schema: DEFAULT_EVENT_SCHEMA,
    ...stamped,
  };

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(payload)}\n`, { flag: "a" });
  return payload;
}

export function readEvents(path: string): EventRecord[] {
  const resolved = resolve(path);

  try {
    const data = readFileSync(resolved, "utf8");
    return data
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as EventRecord & { schema?: string };
        const { schema: _schema, ...event } = parsed;
        return event;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
