export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_PASSWORD_POLICY"
  | "MFA_REQUIRED"
  | "MFA_INVALID"
  | "MFA_ENROLLMENT_REQUIRED"
  | "MFA_ALREADY_ENROLLED"
  | "SESSION_INVALID"
  | "STEP_UP_REQUIRED"
  | "NO_TENANT_SELECTED"
  | "FORBIDDEN"

/** Errors safe to surface to clients: codes and messages never reveal account existence. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message)
    this.name = "AuthError"
  }
}

const defaultMessages: Record<AuthErrorCode, string> = {
  INVALID_CREDENTIALS: "Invalid email or password.",
  INVALID_PASSWORD_POLICY: "Password does not meet the password policy.",
  MFA_REQUIRED: "Multi-factor verification is required.",
  MFA_INVALID: "Invalid verification code.",
  MFA_ENROLLMENT_REQUIRED: "Multi-factor authentication must be enabled for this action.",
  MFA_ALREADY_ENROLLED: "Multi-factor authentication is already enabled.",
  SESSION_INVALID: "Your session has expired. Sign in again.",
  STEP_UP_REQUIRED: "Confirm your identity to continue.",
  NO_TENANT_SELECTED: "Select a workspace to continue.",
  FORBIDDEN: "You do not have permission to perform this action.",
}
