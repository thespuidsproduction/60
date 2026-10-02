import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto"
import { AuthError } from "./errors"

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )

/** scrypt parameters (OWASP-recommended minimum N=2^17 is used for new hashes). */
const CURRENT = { logN: 17, r: 8, p: 1, keylen: 32 }

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

/** Length-based policy (NIST SP 800-63B): no composition rules, generous maximum. */
export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(
      "INVALID_PASSWORD_POLICY",
      `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    )
  }
}

function options(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN
  return { N, r, p, maxmem: 256 * N * r }
}

/** Format: `scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const { logN, r, p, keylen } = CURRENT
  const hash = await scrypt(password.normalize("NFKC"), salt, keylen, options(logN, r, p))
  return ["scrypt", logN, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$")
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const [logN, r, p] = parts.slice(1, 4).map(Number) as [number, number, number]
  if (![logN, r, p].every(Number.isInteger) || logN > 20) return false
  const salt = Buffer.from(parts[4]!, "base64url")
  const expected = Buffer.from(parts[5]!, "base64url")
  const actual = await scrypt(
    password.normalize("NFKC"),
    salt,
    expected.length,
    options(logN, r, p),
  )
  return timingSafeEqual(actual, expected)
}

export function passwordNeedsRehash(stored: string): boolean {
  const [, logN, r, p] = stored.split("$")
  return Number(logN) !== CURRENT.logN || Number(r) !== CURRENT.r || Number(p) !== CURRENT.p
}

let dummyHash: Promise<string> | undefined

/** Equalises timing for unknown accounts so responses don't reveal account existence. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalisation")
  await verifyPassword(password, await dummyHash)
  return false
}
