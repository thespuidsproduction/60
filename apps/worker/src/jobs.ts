import {
  createConnectorRegistry,
  createConnectorSyncJob,
  type AnyConnectorAdapter,
} from "@platform/connectors"
import { fixtureAdapter } from "@platform/connectors/testing"
import {
  createEvidenceCapture,
  createNormaliseJob,
  createTransformerRegistry,
  type ObjectStore,
  type Transformer,
} from "@platform/evidence"
import { fixtureTransformerV1 } from "@platform/evidence/testing"
import { createManifestSigner, createSealJob } from "@platform/integrity"
import type { Db } from "@platform/db"
import type { EventSubscription, JobDefinition } from "@platform/jobs"
import type { AppEnvironment, Logger, SecretBox } from "@platform/shared"

/**
 * Job handlers registered with the worker runtime.
 *
 * Production connectors and transformers are added per connector (Milestone 3).
 * The reference `fixture` connector exists only in local and test environments.
 */
export function workerJobs(options: {
  environment: AppEnvironment
  db: Db
  store: ObjectStore
  secretBox: SecretBox
  signingKeys: string
  log: Logger
}): { jobs: JobDefinition[]; subscriptions: EventSubscription[] } {
  const development = options.environment === "local" || options.environment === "test"
  const adapters: AnyConnectorAdapter[] = development ? [fixtureAdapter] : []
  const transformers: Transformer[] = development ? [fixtureTransformerV1] : []

  const sink = createEvidenceCapture({ db: options.db, store: options.store, log: options.log })
  const sync = createConnectorSyncJob({
    secretBox: options.secretBox,
    registry: createConnectorRegistry(adapters),
    sink,
  })
  const normalise = createNormaliseJob({
    store: options.store,
    transformers: createTransformerRegistry(transformers),
  })
  const seal = createSealJob({
    store: options.store,
    signer: createManifestSigner(options.signingKeys),
  })

  return {
    jobs: [sync, normalise, seal],
    subscriptions: [{ event: "EvidenceCaptured", job: normalise }],
  }
}
