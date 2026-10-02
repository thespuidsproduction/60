"use client"

import gsap from "gsap"
import { Moon, Sun } from "lucide-react"
import { useState } from "react"
import { motion, prefersReducedMotion } from "@/lib/motion"
import { THEME_COOKIE, themes, themeTransitionGroups, type ThemeName } from "@/lib/themes"

/**
 * Midnight ⇄ Limestone (§77). Tokens are tweened in the bible's order —
 * background, navigation and panels, chart/status tokens, typography — over
 * roughly 400 ms, then the theme attribute takes over and inline values clear.
 */
export function ThemeToggle({ initial }: { initial: ThemeName }) {
  const [theme, setTheme] = useState<ThemeName>(initial)

  function apply(next: ThemeName) {
    const root = document.documentElement
    const finish = () => {
      root.dataset.theme = next
      for (const token of Object.keys(themes[next])) root.style.removeProperty(token)
    }
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    setTheme(next)
    if (prefersReducedMotion()) return finish()

    const from = getComputedStyle(root)
    const timeline = gsap.timeline({ onComplete: finish })
    themeTransitionGroups.forEach((group, index) => {
      const start = Object.fromEntries(
        group.map((token) => [token, from.getPropertyValue(token).trim()]),
      )
      const end = Object.fromEntries(group.map((token) => [token, themes[next][token]!]))
      timeline.fromTo(
        root,
        start,
        { ...end, duration: motion.control, ease: "power1.inOut" },
        index * 0.07,
      )
    })
  }

  const next: ThemeName = theme === "midnight" ? "limestone" : "midnight"
  return (
    <button
      type="button"
      onClick={() => apply(next)}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-[var(--motion-control)] hover:bg-elevated hover:text-fg"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "midnight" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}
