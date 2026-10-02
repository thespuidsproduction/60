import type { EventSubscription, JobDefinition } from "@platform/jobs"

/**
 * Job handlers registered with the worker runtime.
 *
 * `connector.sync` is registered in Milestone 2, once the evidence capture
 * sink (raw capture → R2 → SHA-256 → provenance) exists; until then no
 * connectors can be connected, so nothing is enqueued for it.
 */
export function workerJobs(): { jobs: JobDefinition[]; subscriptions: EventSubscription[] } {
  return { jobs: [], subscriptions: [] }
}
