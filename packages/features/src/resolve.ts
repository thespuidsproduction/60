import type { FeatureStateValue } from "@platform/db"
import { featureRegistry, type FeatureKey } from "./registry"

export const FEATURE_UNAVAILABLE_MESSAGE = "Functionality is currently in development."

export interface FeatureViewer {
  tenantId: string | null
  /** Internal employees (Control Plane) see INTERNAL features. */
  internal: boolean
}

export interface FeatureOverride {
  feature_key: string
  tenant_id: string | null
  state: FeatureStateValue
}

export interface ResolvedFeature {
  key: FeatureKey
  state: FeatureStateValue
  enabled: boolean
  /** Exposed but should be labelled beta in the UI. */
  beta: boolean
  source: "tenant" | "environment" | "default"
}

/**
 * Pure resolution: tenant override → environment-wide override → registry default.
 *   ON       exposed to everyone in scope
 *   BETA     exposed, labelled beta (set OFF globally + BETA per tenant for opt-in betas)
 *   INTERNAL exposed to internal employees only
 *   OFF      not exposed; callers show FEATURE_UNAVAILABLE_MESSAGE
 */
export function resolveFeature(
  key: FeatureKey,
  overrides: readonly FeatureOverride[],
  viewer: FeatureViewer,
): ResolvedFeature {
  const tenant = viewer.tenantId
    ? overrides.find((o) => o.feature_key === key && o.tenant_id === viewer.tenantId)
    : undefined
  const global = overrides.find((o) => o.feature_key === key && o.tenant_id === null)
  const state = tenant?.state ?? global?.state ?? featureRegistry[key].default
  const source = tenant ? "tenant" : global ? "environment" : "default"
  const enabled = state === "ON" || state === "BETA" || (state === "INTERNAL" && viewer.internal)
  return { key, state, enabled, beta: state === "BETA", source }
}
