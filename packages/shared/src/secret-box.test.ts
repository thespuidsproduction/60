import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createSecretBox, parseKeyRing } from "./secret-box"

const key = () => randomBytes(32).toString("base64")

describe("secret box", () => {
  it("round-trips and binds associated data", () => {
    const box = createSecretBox(parseKeyRing(`k1:${key()}`))
    const envelope = box.encrypt("JBSWY3DPEHPK3PXP", "user-1")
    expect(envelope.startsWith("v1.k1.")).toBe(true)
    expect(envelope).not.toContain("JBSWY3DPEHPK3PXP")
    expect(box.decrypt(envelope, "user-1")).toBe("JBSWY3DPEHPK3PXP")
    expect(() => box.decrypt(envelope, "user-2")).toThrow()
  })

  it("detects tampering", () => {
    const box = createSecretBox(parseKeyRing(`k1:${key()}`))
    const parts = box.encrypt("secret").split(".")
    parts[3] = Buffer.from("tampered").toString("base64url")
    expect(() => box.decrypt(parts.join("."))).toThrow()
  })

  it("decrypts with retired keys after rotation", () => {
    const oldKey = key()
    const before = createSecretBox(parseKeyRing(`k1:${oldKey}`))
    const envelope = before.encrypt("secret")
    const after = createSecretBox(parseKeyRing(`k2:${key()},k1:${oldKey}`))
    expect(after.activeKeyId).toBe("k2")
    expect(after.decrypt(envelope)).toBe("secret")
    expect(after.keyIdOf(after.encrypt("x"))).toBe("k2")
  })

  it("rejects malformed key rings", () => {
    expect(() => parseKeyRing("")).toThrow()
    expect(() => parseKeyRing(`k1:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/)
    expect(() => parseKeyRing(`k1:${key()},k1:${key()}`)).toThrow(/Duplicate/)
  })
})
