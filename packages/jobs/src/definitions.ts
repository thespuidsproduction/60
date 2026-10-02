import type { Db, QueueName } from "@platform/db"
import type { Logger } from "@platform/shared"
import type { z } from "zod"
import type { DomainEventType } from "./outbox"

export interface JobContext<P> {
  jobId: string
  tenantId: string | null
  correlationId: string
  attempt: number
  payload: P
  db: Db
  log: Logger
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  type: string
  queue: QueueName
  payload: S
  maxAttempts?: number
  run(context: JobContext<z.infer<S>>): Promise<void>
}

export function defineJob<S extends z.ZodType>(definition: JobDefinition<S>): JobDefinition<S> {
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(definition.type)) {
    throw new Error(`Invalid job type "${definition.type}"`)
  }
  return definition
}

/** Fans a domain event out to a job; payload is `{ eventId, ...event.payload }`. */
export interface EventSubscription {
  event: DomainEventType
  job: JobDefinition
}

/** Thrown by handlers for failures that retrying cannot fix (sent straight to dead). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PermanentJobError"
  }
}
