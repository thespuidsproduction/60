import { createHash, randomBytes } from "node:crypto"

/** Opaque session token: 256 bits of randomness, base64url. Only its hash is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}

export function isWellFormedSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}
