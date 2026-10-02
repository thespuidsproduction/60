import type { SourceEnvelope } from "./types"

export interface CaptureContext {
  tenantId: string
  connectorId: string
  syncRunId: string
}

/**
 * Where captured envelopes go. Milestone 2 implements raw capture → object
 * storage → SHA-256 → provenance (§38). The sync orchestrator only advances a
 * cursor after the sink has durably accepted every envelope in the batch.
 */
export interface EvidenceSink {
  /** Returns "duplicate" when (source, source event/object) was already captured (§71). */
  capture(envelope: SourceEnvelope, context: CaptureContext): Promise<"captured" | "duplicate">
  /**
   * Preserves an object the connector could not express as a valid envelope,
   * so nothing upstream is silently dropped (§1.3).
   */
  quarantine(raw: unknown, reason: string, context: CaptureContext): Promise<void>
}
