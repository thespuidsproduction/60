import { generateSigningKey } from "../signing"

/**
 * Prints a new Ed25519 manifest signing key. Store the `MANIFEST_SIGNING_KEYS`
 * entry in the secret store; never commit it. Prepend it to the ring to rotate.
 *
 *   pnpm --filter @platform/integrity generate-signing-key -- k2
 */
const id = process.argv.slice(2).find((arg) => arg !== "--") ?? `k${Date.now()}`
const key = generateSigningKey(id)
process.stdout.write(
  `MANIFEST_SIGNING_KEYS entry (secret):\n${key.id}:${key.privateKeyPkcs8}\n\nPublic key (spki, base64):\n${key.publicKey}\n`,
)
