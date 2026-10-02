/**
 * Theme token values (dev bible §76, D-005). `styles/tokens.css` holds the same
 * values for first paint; a unit test keeps the two in sync. Components only
 * ever reference tokens, so switching theme never touches component logic.
 */
export const themeNames = ["midnight", "limestone"] as const
export type ThemeName = (typeof themeNames)[number]

export const themes: Record<ThemeName, Record<string, string>> = {
  midnight: {
    "--bg-app": "#112532",
    "--bg-surface": "#1b2d38",
    "--bg-elevated": "#223643",
    "--text-primary": "#f3efe9",
    "--text-muted": "#a9aaa5",
    "--accent-primary": "#f4b044",
    "--accent-secondary": "#88a5b7",
    "--status-healthy": "#174a3a",
    "--status-healthy-strong": "#1e5a46",
    "--status-warning": "#e0680e",
    "--status-critical": "#a84a46",
    "--status-unknown": "#88a5b7",
    "--border-subtle": "rgb(136 165 183 / 0.16)",
    "--border-active": "#f4b044",
    "--highlight-inner": "rgb(243 239 233 / 0.03)",
  },
  limestone: {
    "--bg-app": "#f1ece6",
    "--bg-surface": "#ddd5cd",
    "--bg-elevated": "#e8e1da",
    "--text-primary": "#2e2e2e",
    "--text-muted": "#5f5d58",
    "--accent-primary": "#c88e32",
    "--accent-secondary": "#7d4047",
    "--status-healthy": "#174a3a",
    "--status-healthy-strong": "#1e5a46",
    "--status-warning": "#b5543a",
    "--status-critical": "#a84a46",
    "--status-unknown": "#5f5d58",
    "--border-subtle": "rgb(17 37 50 / 0.14)",
    "--border-active": "#c88e32",
    "--highlight-inner": "rgb(255 255 255 / 0.35)",
  },
}

/** §77 sequence: background → navigation/panels → chart/status tokens → typography. */
export const themeTransitionGroups: string[][] = [
  ["--bg-app"],
  ["--bg-surface", "--bg-elevated", "--border-subtle", "--highlight-inner"],
  [
    "--accent-primary",
    "--accent-secondary",
    "--status-healthy",
    "--status-healthy-strong",
    "--status-warning",
    "--status-critical",
    "--status-unknown",
    "--border-active",
  ],
  ["--text-primary", "--text-muted"],
]

export const THEME_COOKIE = "theme"

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (themeNames as readonly string[]).includes(value)
}
