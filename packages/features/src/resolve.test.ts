import { describe, expect, it } from "vitest"
import { resolveFeature, type FeatureOverride } from "./resolve"

const viewer = { tenantId: "t1", internal: false }

describe("resolveFeature", () => {
  it("falls back to the registry default", () => {
    expect(resolveFeature("ai.investigation", [], viewer)).toMatchObject({
      state: "OFF",
      enabled: false,
      source: "default",
    })
  })

  it("tenant override beats environment override", () => {
    const overrides: FeatureOverride[] = [
      { feature_key: "ai.investigation", tenant_id: null, state: "OFF" },
      { feature_key: "ai.investigation", tenant_id: "t1", state: "BETA" },
    ]
    expect(resolveFeature("ai.investigation", overrides, viewer)).toMatchObject({
      state: "BETA",
      enabled: true,
      beta: true,
      source: "tenant",
    })
    expect(
      resolveFeature("ai.investigation", overrides, { tenantId: "t2", internal: false }),
    ).toMatchObject({
      enabled: false,
      source: "environment",
    })
  })

  it("INTERNAL is only exposed to internal viewers", () => {
    expect(resolveFeature("forensics.advanced", [], viewer).enabled).toBe(false)
    expect(
      resolveFeature("forensics.advanced", [], { tenantId: null, internal: true }).enabled,
    ).toBe(true)
  })

  it("ignores other tenants' overrides", () => {
    const overrides: FeatureOverride[] = [
      { feature_key: "portal.customer", tenant_id: "t9", state: "ON" },
    ]
    expect(resolveFeature("portal.customer", overrides, viewer).enabled).toBe(false)
  })
})

describe("feature registry", () => {
  it("every key satisfies the feature_states.feature_key database constraint", async () => {
    const { featureRegistry } = await import("./registry")
    for (const key of Object.keys(featureRegistry)) {
      expect(key).toMatch(/^[a-z0-9]+(\.[a-z0-9_]+)*$/)
    }
  })
})
