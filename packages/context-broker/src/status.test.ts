import { describe, expect, it } from "vitest";
import { contextBrokerFeatureStatus, serializeContextBrokerFeatureStatus } from "./status.js";

describe("contextBrokerFeatureStatus", () => {
  it("distinguishes disabled, unavailable, error, and ready states", () => {
    expect(contextBrokerFeatureStatus({ enabled: false, registered: false }).health).toBe("disabled");
    expect(contextBrokerFeatureStatus({ enabled: true, registered: false }).health).toBe("unavailable");
    expect(contextBrokerFeatureStatus({ enabled: true, registered: false, error: true }).health).toBe("error");
    expect(contextBrokerFeatureStatus({ enabled: true, registered: true, durable: true, backend: "sqlite" })).toMatchObject({ health: "ready", mode: "sqlite" });
    expect(contextBrokerFeatureStatus({ enabled: true, registered: true, backend: "/private/user/secret" }).health).toBe("error");
  });

  it("serializes only bounded status metadata", () => {
    const serialized = serializeContextBrokerFeatureStatus({ enabled: true, registered: true, durable: false, backend: "memory" });
    expect(serialized).toContain('"feature":"context-broker"');
    expect(serialized).not.toContain("/");
    expect(serialized).not.toContain("path");
  });
});
