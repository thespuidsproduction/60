import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { withSystem, type Db } from "@platform/db"

/**
 * Manifest signing keys (dev bible §120).
 *
 * Private keys are supplied by the secret store (`MANIFEST_SIGNING_KEYS`,
 * `id:base64(PKCS#8 DER)`, first = active) and never touch the database.
 * Public keys are registered in `signing_keys` and never deleted, so manifests
 * signed by retired keys remain verifiable.
 */
export interface ManifestSigner {
  keyId: string
  publicKey: string
  sign(message: Buffer): string
}

const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function publicKeyToBase64(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64")
}

export function parseSigningKeyRing(
  spec: string,
): { id: string; privateKey: KeyObject; publicKey: string }[] {
  const keys = spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":")
      const id = entry.slice(0, separator)
      if (separator < 1 || !KEY_ID.test(id))
        throw new Error("Signing key entries must be id:base64pkcs8")
      const privateKey = createPrivateKey({
        key: Buffer.from(entry.slice(separator + 1), "base64"),
        format: "der",
        type: "pkcs8",
      })
      if (privateKey.asymmetricKeyType !== "ed25519")
        throw new Error(`Signing key ${id} is not Ed25519`)
      return { id, privateKey, publicKey: publicKeyToBase64(createPublicKey(privateKey)) }
    })
  if (!keys.length) throw new Error("No manifest signing keys configured")
  if (new Set(keys.map((k) => k.id)).size !== keys.length)
    throw new Error("Duplicate signing key id")
  return keys
}

export function createManifestSigner(spec: string): ManifestSigner {
  const [active] = parseSigningKeyRing(spec)
  return {
    keyId: active!.id,
    publicKey: active!.publicKey,
    sign: (message) => sign(null, message, active!.privateKey).toString("base64"),
  }
}

export function verifySignature(
  publicKeyBase64: string,
  message: Buffer,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    })
    return verify(null, message, key, Buffer.from(signatureBase64, "base64"))
  } catch {
    return false
  }
}

export function generateSigningKey(id: string): {
  id: string
  privateKeyPkcs8: string
  publicKey: string
} {
  if (!KEY_ID.test(id)) throw new Error("Invalid key id")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    id,
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKeyToBase64(publicKey),
  }
}

/**
 * Registers the public halves of every configured key. Reusing a key id for a
 * different key is refused: historical signatures must stay unambiguous.
 */
export async function registerSigningKeys(db: Db, spec: string): Promise<void> {
  const keys = parseSigningKeyRing(spec)
  await withSystem(db, "integrity.register_keys", async (trx) => {
    for (const key of keys) {
      const existing = await trx
        .selectFrom("signing_keys")
        .select(["public_key"])
        .where("id", "=", key.id)
        .executeTakeFirst()
      if (existing && existing.public_key !== key.publicKey) {
        throw new Error(
          `Signing key id ${key.id} is already registered with a different public key`,
        )
      }
      if (!existing) {
        await trx
          .insertInto("signing_keys")
          .values({ id: key.id, algorithm: "ed25519", public_key: key.publicKey })
          .execute()
      }
    }
  })
}

/** Retires a key: it stops signing (remove it from the ring) but keeps verifying. */
export async function retireSigningKey(db: Db, keyId: string): Promise<void> {
  await withSystem(db, "integrity.retire_key", (trx) =>
    trx
      .updateTable("signing_keys")
      .set({ status: "retired", retired_at: new Date() })
      .where("id", "=", keyId)
      .execute(),
  )
}
