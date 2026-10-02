/**
 * Motion tokens (dev bible §79, §136). Durations in seconds for GSAP; the CSS
 * equivalents live in styles/tokens.css. Never hard-code durations elsewhere.
 */
export const motion = {
  micro: 0.15,
  control: 0.19,
  panel: 0.28,
  route: 0.38,
  dashboard: 0.52,
  graph: 0.7,
} as const

export const ease = "power2.out"

/** True when the user asked for reduced motion (§85). Animations then resolve instantly. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}
