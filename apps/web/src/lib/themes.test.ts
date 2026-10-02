import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { themeTransitionGroups, themes } from "./themes"

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8")

function block(selector: string) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return css.slice(start, css.indexOf("}", start))
}

describe("theme tokens", () => {
  it("match styles/tokens.css for both themes", () => {
    for (const [name, selector] of [
      ["midnight", '[data-theme="midnight"]'],
      ["limestone", '[data-theme="limestone"]'],
    ] as const) {
      const body = block(selector)
      for (const [token, value] of Object.entries(themes[name])) {
        expect(body, `${name} ${token}`).toContain(`${token}: ${value};`)
      }
    }
  })

  it("transition every token exactly once", () => {
    const grouped = themeTransitionGroups.flat()
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped.sort()).toEqual(Object.keys(themes.midnight).sort())
  })
})
