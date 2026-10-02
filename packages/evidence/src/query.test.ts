import { describe, expect, it } from "vitest"
import { parseEvidenceQuery } from "./query"

const today = new Date("2026-10-02T12:00:00Z")

describe("parseEvidenceQuery", () => {
  it("parses the §19 example filters", () => {
    const { query, errors } = parseEvidenceQuery(
      "identity:alice source:entra type:privilege_change between:02:00..04:00",
      { today },
    )
    expect(errors).toEqual([])
    expect(query).toMatchObject({
      identity: ["alice"],
      source: ["entra"],
      type: ["privilege_change"],
    })
    expect(query.between).toEqual({
      from: new Date("2026-10-02T02:00:00.000Z"),
      to: new Date("2026-10-02T04:00:00.999Z"),
    })
  })

  it("anchors times to on:, supports dates, ISO and quoted values, ORs repeated keys", () => {
    const { query } = parseEvidenceQuery(
      'on:2026-03-14 between:02:17..02:39 asset:"SRV ACME" source:a source:b disabled',
      { today },
    )
    expect(query.between?.from.toISOString()).toBe("2026-03-14T02:17:00.000Z")
    expect(query.asset).toEqual(["SRV ACME"])
    expect(query.source).toEqual(["a", "b"])
    expect(query.text).toEqual(["disabled"])
    expect(
      parseEvidenceQuery("between:2026-03-01..2026-03-02").query.between?.to.toISOString(),
    ).toBe("2026-03-02T23:59:59.999Z")
    expect(parseEvidenceQuery("on:2026-03-14").query.between?.from.toISOString()).toBe(
      "2026-03-14T00:00:00.000Z",
    )
  })

  it("validates values and explains filters that arrive in later milestones", () => {
    const { errors, query } = parseEvidenceQuery(
      "severity:catastrophic trust:Z integrity:verified ref:EV-12 customer:acme nope:1 between:04:00..02:00",
      { today },
    )
    expect(query.integrity).toEqual(["verified"])
    expect(query.reference).toEqual(["EV-12"])
    expect(errors).toEqual([
      'Unknown severity "catastrophic".',
      "Trust level must be A–E.",
      "Customer filtering becomes available with customer mapping.",
      'Unknown filter "nope:".',
      '"between:" start is after its end.',
    ])
  })
})
