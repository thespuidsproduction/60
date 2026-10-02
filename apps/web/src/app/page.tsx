import { loadBrand } from "@platform/shared"

export default function HomePage() {
  const brand = loadBrand()
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6">
      <p className="font-mono text-xs tracking-widest text-muted uppercase">{brand.productName}</p>
      <h1 className="text-3xl font-semibold">
        When something goes wrong, we reconstruct and prove what happened.
      </h1>
      <p className="text-muted">The application is being built. No dashboards are exposed yet.</p>
    </main>
  )
}
