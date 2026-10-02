import type { Transformer } from "../normalise"

/**
 * Transformer for the reference `fixture` connector. Real connectors ship
 * their own transformers (Milestone 3); this one exercises the framework.
 */
const severities = new Set(["info", "low", "medium", "high", "critical"])

function build(version: string, schemaVersion: string): Transformer {
  return {
    name: "fixture-transformer",
    version,
    source: "fixture",
    objectTypes: ["event"],
    schemaVersion,
    transform(envelope) {
      const p = (envelope.payload ?? {}) as Record<string, unknown>
      const type = typeof p.type === "string" ? p.type : "unknown"
      const user = typeof p.user === "string" ? p.user : null
      const device = typeof p.device === "string" ? p.device : null
      const severity =
        typeof p.severity === "string" && severities.has(p.severity) ? p.severity : "info"
      return {
        eventType: `fixture.${type.replace(/[^a-z0-9_]/g, "_")}`,
        category: typeof p.category === "string" ? p.category : "audit",
        severity: severity as "info",
        description:
          typeof p.description === "string"
            ? p.description
            : `${type.replace(/_/g, " ")}${user ? ` by ${user}` : ""}`,
        subjectType: user ? "identity" : null,
        subjectId: user,
        assetType: device ? "endpoint" : null,
        assetId: device,
        occurredAt: envelope.sourceTimestamp,
        payload:
          version === "1.0.0" ? { type, user, device } : { type, user, device, ip: p.ip ?? null },
      }
    },
  }
}

export const fixtureTransformerV1 = build("1.0.0", "evidence.fixture.event.v1")
/** v2 adds the source IP: used to prove reprocessing keeps v1 outputs (§112). */
export const fixtureTransformerV2 = build("2.0.0", "evidence.fixture.event.v2")
