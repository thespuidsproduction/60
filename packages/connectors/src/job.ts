import { z } from "zod"
import { defineJob } from "@platform/jobs"
import { runConnectorSync, type SyncDependencies } from "./sync"

export const connectorSyncPayload = z.object({
  connectorId: z.string().uuid(),
  mode: z.enum(["baseline", "incremental"]),
})

/** The `connector.sync` job (queue: connector-sync). */
export function createConnectorSyncJob(deps: Omit<SyncDependencies, "db" | "log">) {
  return defineJob({
    type: "connector.sync",
    queue: "connector-sync",
    payload: connectorSyncPayload,
    maxAttempts: 5,
    async run({ payload, jobId, attempt, db, log }) {
      await runConnectorSync({ ...deps, db, log }, { ...payload, jobId, attempt })
    },
  })
}
