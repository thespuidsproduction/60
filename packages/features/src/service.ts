import { recordAudit, type AuditActor, type AuditRequestContext } from "@platform/audit"
import { withSystem, type Db, type FeatureStateValue } from "@platform/db"
import type { AppEnvironment } from "@platform/shared"
import { featureRegistry, isFeatureKey, type FeatureKey } from "./registry"
import {
  FEATURE_UNAVAILABLE_MESSAGE,
  resolveFeature,
  type FeatureViewer,
  type ResolvedFeature,
} from "./resolve"

export class FeatureUnavailableError extends Error {
  constructor(readonly key: FeatureKey) {
    super(FEATURE_UNAVAILABLE_MESSAGE)
    this.name = "FeatureUnavailableError"
  }
}

export function createFeatureService(options: { db: Db; environment: AppEnvironment }) {
  const { db, environment } = options

  async function loadOverrides(tenantId: string | null) {
    return withSystem(db, "features.read", (trx) =>
      trx
        .selectFrom("feature_states")
        .select(["feature_key", "tenant_id", "state"])
        .where("environment", "=", environment)
        .where((eb) =>
          tenantId
            ? eb.or([eb("tenant_id", "is", null), eb("tenant_id", "=", tenantId)])
            : eb("tenant_id", "is", null),
        )
        .execute(),
    )
  }

  return {
    async resolve(key: FeatureKey, viewer: FeatureViewer): Promise<ResolvedFeature> {
      return resolveFeature(key, await loadOverrides(viewer.tenantId), viewer)
    },

    async resolveAll(viewer: FeatureViewer): Promise<Record<FeatureKey, ResolvedFeature>> {
      const overrides = await loadOverrides(viewer.tenantId)
      const keys = Object.keys(featureRegistry) as FeatureKey[]
      return Object.fromEntries(
        keys.map((key) => [key, resolveFeature(key, overrides, viewer)]),
      ) as Record<FeatureKey, ResolvedFeature>
    },

    /** Server-side guard: throws FeatureUnavailableError when the feature is not exposed. */
    async require(key: FeatureKey, viewer: FeatureViewer): Promise<ResolvedFeature> {
      const resolved = await this.resolve(key, viewer)
      if (!resolved.enabled) throw new FeatureUnavailableError(key)
      return resolved
    },

    /**
     * Changes exposure. Caller must already be authorised (internal Father/Ops role).
     * Every change is audited with its previous state; `state: null` removes the
     * override so the registry default applies again.
     */
    async setState(input: {
      key: string
      tenantId: string | null
      state: FeatureStateValue | null
      actor: AuditActor
      reason: string
      request?: AuditRequestContext
    }) {
      if (!isFeatureKey(input.key)) throw new Error(`Unknown feature key "${input.key}"`)
      if (!input.reason.trim()) throw new Error("A reason is required to change feature state")
      const key = input.key
      await withSystem(db, "features.write", async (trx) => {
        const scope = (q: typeof base) =>
          input.tenantId
            ? q.where("tenant_id", "=", input.tenantId)
            : q.where("tenant_id", "is", null)
        const base = trx
          .selectFrom("feature_states")
          .select(["id", "state"])
          .where("feature_key", "=", key)
          .where("environment", "=", environment)
        const previous = await scope(base).executeTakeFirst()

        if (input.state === null) {
          if (previous)
            await trx.deleteFrom("feature_states").where("id", "=", previous.id).execute()
        } else if (previous) {
          await trx
            .updateTable("feature_states")
            .set({
              state: input.state,
              reason: input.reason,
              updated_by: input.actor.label,
              updated_at: new Date(),
            })
            .where("id", "=", previous.id)
            .execute()
        } else {
          await trx
            .insertInto("feature_states")
            .values({
              feature_key: key,
              environment,
              tenant_id: input.tenantId,
              state: input.state,
              reason: input.reason,
              updated_by: input.actor.label,
            })
            .execute()
        }

        await recordAudit(trx, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: "feature.state_changed",
          target: { type: "feature", id: `${environment}:${key}` },
          oldState: { state: previous?.state ?? null },
          newState: { state: input.state },
          reason: input.reason,
          ...(input.request ? { request: input.request } : {}),
        })
      })
    },
  }
}

export type FeatureService = ReturnType<typeof createFeatureService>
