"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { AuthCard } from "@/components/auth-card"
import { Field, FormError, postJson, SubmitButton } from "@/components/form"

export default function MfaPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      const result = await postJson("/api/auth/mfa", { code: form.get("code") })
      router.push(result.tenantSelected ? "/command" : "/select-workspace")
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }

  return (
    <AuthCard title="Verification code">
      <form onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <p className="mb-4 text-sm text-muted">
          Enter the 6-digit code from your authenticator app, or a backup code.
        </p>
        <Field
          label="Code"
          name="code"
          inputMode="text"
          autoComplete="one-time-code"
          required
          autoFocus
        />
        <SubmitButton pending={pending}>{pending ? "Verifying…" : "Verify"}</SubmitButton>
      </form>
    </AuthCard>
  )
}
