import type { CaptureContext, EvidenceSink } from "../sink"
import type { SourceEnvelope } from "../types"

/** In-memory sink with (source, source event/object id) deduplication (§71). */
export function createMemorySink(options: { failAfter?: number } = {}) {
  const captured: SourceEnvelope[] = []
  const quarantined: { raw: unknown; reason: string; context: CaptureContext }[] = []
  const keys = new Set<string>()
  let calls = 0
  const sink: EvidenceSink = {
    async capture(envelope) {
      calls++
      if (options.failAfter !== undefined && calls > options.failAfter)
        throw new Error("sink unavailable")
      const key = `${envelope.source}:${envelope.sourceTenant}:${envelope.sourceEventId ?? envelope.sourceObjectId}`
      if (keys.has(key)) return "duplicate"
      keys.add(key)
      captured.push(envelope)
      return "captured"
    },
    async quarantine(raw, reason, context) {
      quarantined.push({ raw, reason, context })
    },
  }
  return { sink, captured, quarantined }
}
