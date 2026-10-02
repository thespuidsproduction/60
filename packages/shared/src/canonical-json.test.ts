import { describe, expect, it } from "vitest"
import { canonicalJson } from "./canonical-json"

describe("canonicalJson", () => {
  it("sorts keys recursively and is order-independent", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "é" } })
    const b = canonicalJson({ a: { c: "é", d: [3, { x: 2, y: 1 }] }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}')
  })

  it("drops undefined properties like JSON and rejects unsafe values", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(() => canonicalJson({ n: Number.NaN })).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/Cyclic/)
    expect(() => canonicalJson({ big: 1n })).toThrow()
  })

  it("allows the same object twice when not cyclic", () => {
    const shared = { x: 1 }
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
  })
})
