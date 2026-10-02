import type { FeatureStateValue } from "@platform/db"

/**
 * Every exposure-controlled capability is registered here (dev bible §35, §89).
 * The functionality may already exist in code; the feature state controls
 * whether it is exposed. Defaults apply when no database override exists.
 */
export interface FeatureDefinition {
  description: string
  /** Default when no override row exists. Production defaults should be OFF until released. */
  default: FeatureStateValue
}

export const featureRegistry = {
  "incidents.blast_radius_v2": {
    description: "Blast Radius V2 spatial visualisation.",
    default: "OFF",
  },
  "ai.investigation": {
    description: "AI-assisted investigation: summaries, gap and contradiction detection.",
    default: "OFF",
  },
  "regulatory.submission": {
    description: "Recording external regulatory submissions from the platform.",
    default: "OFF",
  },
  "forensics.advanced": {
    description: "Advanced forensics tooling.",
    default: "INTERNAL",
  },
  "portal.customer": {
    description: "Downstream customer-facing portal.",
    default: "OFF",
  },
  "connector.microsoft_entra": { description: "Microsoft Entra connector.", default: "OFF" },
  "connector.microsoft_sentinel": { description: "Microsoft Sentinel connector.", default: "OFF" },
  "connector.connectwise_psa": { description: "ConnectWise PSA connector.", default: "OFF" },
  "connector.ninjaone": { description: "NinjaOne RMM connector.", default: "OFF" },
  "connector.crowdstrike": { description: "CrowdStrike Falcon connector.", default: "OFF" },
  "reports.print": { description: "Printable report rendering.", default: "OFF" },
} as const satisfies Record<string, FeatureDefinition>

export type FeatureKey = keyof typeof featureRegistry

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.hasOwn(featureRegistry, key)
}
