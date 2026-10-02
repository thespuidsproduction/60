"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { AuthCard } from "@/components/auth-card"
import { Field, FormError, postJson, SubmitButton } from "@/components/form"

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      const result = await postJson("/api/auth/login", {
        email: form.get("email"),
        password: form.get("password"),
      })
      router.push(
        result.mfaRequired
          ? "/login/mfa"
          : result.tenantSelected
            ? "/command"
            : "/select-workspace",
      )
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <Field label="Email" name="email" type="email" autoComplete="username" required autoFocus />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <SubmitButton pending={pending}>{pending ? "Signing in…" : "Sign in"}</SubmitButton>
      </form>
    </AuthCard>
  )
}
