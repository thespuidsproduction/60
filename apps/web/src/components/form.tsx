"use client"

import type { InputHTMLAttributes, ReactNode } from "react"

export function Field({
  label,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      <input
        {...props}
        className="w-full rounded-md border border-border-subtle bg-app px-3 py-2 text-fg transition-colors duration-[var(--motion-control)] outline-none focus:border-border-active"
      />
    </label>
  )
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 w-full rounded-md bg-accent px-3 py-2 font-semibold text-[#112532] transition-opacity duration-[var(--motion-control)] disabled:opacity-60"
    >
      {children}
    </button>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="mb-4 rounded-md border border-critical px-3 py-2 text-sm">
      <span className="font-mono text-xs uppercase">Error</span> · {message}
    </p>
  )
}

export async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error?.message ?? "Request failed.")
  }
  return data
}
