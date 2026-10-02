import { describe, expect, it } from "vitest"
import { createMemoryObjectStore, ObjectIntegrityError, sha256Hex } from "./object-store"
import { keyBelongsToTenant, manifestKey, rawEvidenceKey } from "./storage-keys"

const tenant = "0b6f2c64-6f0c-4c5d-9a39-3f7a3c1d8e11"
const evidence = "5a1f3d0e-2b7c-4e8a-9f61-0c2d3e4f5a6b"

describe("storage keys", () => {
  it("follows the §109 raw evidence layout in UTC", () => {
    expect(
      rawEvidenceKey({
        tenantId: tenant,
        source: "microsoft-entra",
        evidenceId: evidence,
        capturedAt: new Date("2026-03-14T23:59:59-02:00"),
      }),
    ).toBe(`tenant/${tenant}/raw/year=2026/month=03/day=15/source=microsoft-entra/${evidence}.json`)
  })

  it("rejects traversal and non-system identifiers", () => {
    expect(() => manifestKey("../x", evidence)).toThrow()
    expect(() =>
      rawEvidenceKey({
        tenantId: tenant,
        source: "../etc",
        evidenceId: evidence,
        capturedAt: new Date(),
      }),
    ).toThrow()
    expect(() =>
      rawEvidenceKey({ tenantId: tenant, source: "x", evidenceId: "EV-1", capturedAt: new Date() }),
    ).toThrow()
  })

  it("checks tenant ownership by prefix", () => {
    expect(keyBelongsToTenant(manifestKey(tenant, evidence), tenant)).toBe(true)
    expect(keyBelongsToTenant(manifestKey(evidence, tenant), tenant)).toBe(false)
  })
})

describe("memory object store", () => {
  it("is write-once with idempotent identical retries", async () => {
    const store = createMemoryObjectStore()
    const body = Buffer.from('{"a":1}')
    const sha256 = sha256Hex(body)
    expect(
      (await store.putImmutable("k", body, { contentType: "application/json", sha256 }))
        .alreadyExisted,
    ).toBe(false)
    expect(
      (await store.putImmutable("k", body, { contentType: "application/json", sha256 }))
        .alreadyExisted,
    ).toBe(true)
    const other = Buffer.from('{"a":2}')
    await expect(
      store.putImmutable("k", other, { contentType: "application/json", sha256: sha256Hex(other) }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError)
    await expect(
      store.putImmutable("k2", other, { contentType: "application/json", sha256 }),
    ).rejects.toThrow(/does not match/)
  })
})
