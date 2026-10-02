import { createHash, randomBytes } from "node:crypto"

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I
export const BACKUP_CODE_COUNT = 10

/**
 * Backup codes carry 80 bits of entropy (16 symbols × 5 bits), so a fast SHA-256
 * hash is sufficient: they cannot be brute-forced like human-chosen passwords.
 */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(16)
    const symbols = [...bytes].map((byte) => ALPHABET[byte % 32]).join("")
    return symbols.match(/.{4}/g)!.join("-")
  })
}

export function normaliseBackupCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(normaliseBackupCode(code)).digest("hex")
}

export function looksLikeBackupCode(code: string): boolean {
  return normaliseBackupCode(code).length === 16
}
