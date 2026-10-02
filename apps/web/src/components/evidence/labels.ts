import type { StatusTone } from "@/components/ui/status-badge"

/** Trust levels (§40) — the UI must expose the distinction. */
export const trustLevels: Record<string, string> = {
  A: "Direct machine/API capture",
  B: "Digitally signed imported artifact",
  C: "Human-uploaded artifact",
  D: "Human statement / attestation",
  E: "AI-derived information",
}

export const integrityDisplay: Record<string, { tone: StatusTone; label: string; help: string }> = {
  verified: {
    tone: "healthy",
    label: "Verified",
    help: "All seven integrity checks passed on the latest verification.",
  },
  sealed: {
    tone: "neutral",
    label: "Sealed",
    help: "Included in a signed manifest. Run verification to re-check from first principles.",
  },
  unsealed: {
    tone: "unknown",
    label: "Pending seal",
    help: "Captured and hashed; awaiting the next signed manifest.",
  },
  failed: { tone: "critical", label: "Failed", help: "The latest verification found a mismatch." },
}

export const severityTone: Record<string, StatusTone> = {
  critical: "critical",
  high: "warning",
  medium: "neutral",
  low: "unknown",
  info: "unknown",
}

export const checkLabels: Record<string, string> = {
  SOURCE: "Source",
  ORIGINAL_OBJECT: "Original object",
  RAW_HASH: "Raw hash",
  TIMESTAMP: "Timestamp",
  MANIFEST: "Manifest",
  SIGNATURE: "Signature",
  CHAIN: "Chain",
}
