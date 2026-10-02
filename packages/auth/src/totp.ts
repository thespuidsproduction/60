import { generateSecret, generateURI, verify } from "otplib"

export const TOTP_PERIOD_SECONDS = 30

export function createTotpSecret(): string {
  return generateSecret()
}

export function totpUri(options: { issuer: string; accountLabel: string; secret: string }): string {
  return generateURI({
    issuer: options.issuer,
    label: options.accountLabel,
    secret: options.secret,
  })
}

export type TotpCheck = { valid: true; timeStep: number } | { valid: false }

/**
 * Verifies a 6-digit TOTP code allowing one period of clock skew either side.
 * `lastTimeStep` rejects replay of a code (or an earlier one) that was already used.
 */
export async function checkTotp(options: {
  secret: string
  code: string
  lastTimeStep?: number | null
  epochSeconds?: number
}): Promise<TotpCheck> {
  const code = options.code.replace(/\s+/g, "")
  if (!/^\d{6}$/.test(code)) return { valid: false }
  const result = await verify({
    secret: options.secret,
    token: code,
    epochTolerance: TOTP_PERIOD_SECONDS,
    ...(options.lastTimeStep != null ? { afterTimeStep: options.lastTimeStep } : {}),
    ...(options.epochSeconds != null ? { epoch: options.epochSeconds } : {}),
  })
  // The functional API's result type is a TOTP/HOTP union; TOTP results carry timeStep.
  if (!result.valid || !("timeStep" in result)) return { valid: false }
  return { valid: true, timeStep: result.timeStep }
}
