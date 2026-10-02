import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Authenticated encryption for secrets stored at rest (TOTP secrets, connector
 * credential material; dev bible §59, §107).
 *
 * Envelope: `v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts), AES-256-GCM.
 * Keys come from a key ring so they can be rotated: the first key encrypts,
 * every key in the ring can decrypt. Optional associated data binds a
 * ciphertext to its owner (e.g. a user ID) so it cannot be swapped between rows.
 */
export interface SecretBox {
  readonly activeKeyId: string
  encrypt(plaintext: string, associatedData?: string): string
  decrypt(envelope: string, associatedData?: string): string
  keyIdOf(envelope: string): string
}

const KEY_ID = /^[a-z0-9_-]{1,32}$/i

/** Parses `id:base64key,id:base64key` (first entry is active). */
export function parseKeyRing(spec: string): Map<string, Buffer> {
  const ring = new Map<string, Buffer>()
  for (const entry of spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":")
    if (separator < 1) throw new Error("Key ring entries must be id:base64key")
    const id = entry.slice(0, separator)
    const key = Buffer.from(entry.slice(separator + 1), "base64")
    if (!KEY_ID.test(id)) throw new Error("Invalid key id in key ring")
    if (key.length !== 32) throw new Error(`Key ${id} must be 32 bytes`)
    if (ring.has(id)) throw new Error(`Duplicate key id ${id}`)
    ring.set(id, key)
  }
  if (ring.size === 0) throw new Error("Key ring is empty")
  return ring
}

export function createSecretBox(ring: Map<string, Buffer>): SecretBox {
  const [activeKeyId, activeKey] = [...ring.entries()][0]!

  const parse = (envelope: string) => {
    const parts = envelope.split(".")
    if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Malformed secret envelope")
    const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string]
    return { keyId, iv, ciphertext, tag }
  }

  return {
    activeKeyId,
    encrypt(plaintext, associatedData) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", activeKey, iv)
      if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, "utf8"))
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return ["v1", activeKeyId, iv, ciphertext, tag]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".")
    },
    decrypt(envelope, associatedData) {
      const { keyId, iv, ciphertext, tag } = parse(envelope)
      const key = ring.get(keyId)
      if (!key) throw new Error(`Unknown encryption key id ${keyId}`)
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
      if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData, "utf8"))
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")
    },
    keyIdOf(envelope) {
      return parse(envelope).keyId
    },
  }
}
