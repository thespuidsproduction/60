import { sql, type Tx } from "@platform/db"
import type { EvidenceQuery, IntegrityState } from "./query"

/**
 * Evidence Explorer search (dev bible §19, §69: PostgreSQL first).
 *
 * One row per raw evidence object with its latest normalised interpretation
 * and its derived integrity state:
 *   failed / verified  — outcome of the most recent verification
 *   sealed             — included in a signed manifest, not yet re-verified
 *   unsealed           — captured, awaiting the next integrity seal
 * Must run inside withTenant(): row-level security scopes every table.
 */
export interface EvidenceListItem {
  id: string
  reference: string
  source: string
  objectType: string
  eventType: string | null
  severity: string | null
  description: string | null
  subjectId: string | null
  assetId: string | null
  occurredAt: string | null
  observedAt: string
  ingestedAt: string
  rawSha256: string
  trustLevel: string
  integrity: IntegrityState
  manifestSequence: number | null
  transformerVersion: string | null
  schemaVersion: string | null
}

export interface SearchPage {
  items: EvidenceListItem[]
  nextCursor: string | null
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

function encodeCursor(sortAt: Date, id: string) {
  return Buffer.from(JSON.stringify([sortAt.toISOString(), id])).toString("base64url")
}

function decodeCursor(cursor: string): [Date, string] | null {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      string,
      string,
    ]
    const date = new Date(at)
    if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) return null
    return [date, id]
  } catch {
    return null
  }
}

function baseQuery(trx: Tx) {
  return trx
    .selectFrom("raw_evidence_objects as r")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("evidence_events as e")
          .select([
            "e.event_type",
            "e.severity",
            "e.description",
            "e.subject_id",
            "e.asset_id",
            "e.occurred_at as event_occurred_at",
            "e.transformer_version",
            "e.schema_version",
          ])
          .whereRef("e.raw_object_id", "=", "r.id")
          .orderBy("e.created_at", "desc")
          .limit(1)
          .as("e"),
      (join) => join.onTrue(),
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("evidence_verifications as v")
          .select("v.result")
          .whereRef("v.raw_object_id", "=", "r.id")
          .where("v.result", "in", ["verified", "failed"])
          .orderBy("v.verified_at", "desc")
          .limit(1)
          .as("v"),
      (join) => join.onTrue(),
    )
    .leftJoin("integrity_manifest_items as i", "i.raw_object_id", "r.id")
    .leftJoin("integrity_manifests as m", "m.id", "i.manifest_id")
    .select([
      "r.id",
      "r.reference",
      "r.source",
      "r.object_type",
      "r.observed_at",
      "r.ingested_at",
      "r.raw_sha256",
      "r.trust_level",
      "e.event_type",
      "e.severity",
      "e.description",
      "e.subject_id",
      "e.asset_id",
      "e.transformer_version",
      "e.schema_version",
      "m.sequence as manifest_sequence",
      sql<Date | null>`coalesce(e.event_occurred_at, r.occurred_at)`.as("occurred_at"),
      sql<Date>`coalesce(e.event_occurred_at, r.occurred_at, r.observed_at)`.as("sort_at"),
      sql<IntegrityState>`case
        when v.result = 'failed' then 'failed'
        when v.result = 'verified' then 'verified'
        when i.manifest_id is not null then 'sealed'
        else 'unsealed' end`.as("integrity"),
    ])
}

export async function searchEvidence(
  trx: Tx,
  query: EvidenceQuery,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<SearchPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  let q = trx.selectFrom(baseQuery(trx).as("x")).selectAll()

  const anyOf = <T>(values: T[], build: (value: T) => ReturnType<typeof sql<boolean>>) =>
    values.length ? sql<boolean>`(${sql.join(values.map(build), sql` or `)})` : null

  const conditions = [
    anyOf(query.source, (v) => sql<boolean>`x.source = ${v}`),
    anyOf(
      query.type,
      (v) =>
        sql<boolean>`(x.event_type = ${v} or x.event_type like ${"%." + v} or x.object_type = ${v})`,
    ),
    anyOf(query.identity, (v) => sql<boolean>`x.subject_id ilike ${like(v)}`),
    anyOf(query.asset, (v) => sql<boolean>`x.asset_id ilike ${like(v)}`),
    anyOf(
      query.reference,
      (v) =>
        sql<boolean>`x.reference = ${v.replace(/^EV-(\d+)$/, (_, n: string) => `EV-${n.padStart(6, "0")}`)}`,
    ),
    anyOf(query.severity, (v) => sql<boolean>`x.severity = ${v}`),
    anyOf(query.trust, (v) => sql<boolean>`x.trust_level = ${v}`),
    anyOf(query.integrity, (v) => sql<boolean>`x.integrity = ${v}`),
    ...query.text.map(
      (t) => sql<boolean>`(x.description ilike ${like(t)} or x.reference ilike ${like(t)})`,
    ),
    query.between
      ? sql<boolean>`x.sort_at between ${query.between.from} and ${query.between.to}`
      : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null)
  for (const condition of conditions) q = q.where(condition)

  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  if (cursor) q = q.where(sql<boolean>`(x.sort_at, x.id) < (${cursor[0]}, ${cursor[1]}::uuid)`)

  const rows = await q
    .orderBy("x.sort_at", "desc")
    .orderBy("x.id", "desc")
    .limit(limit + 1)
    .execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => ({
      id: row.id,
      reference: row.reference,
      source: row.source,
      objectType: row.object_type,
      eventType: row.event_type,
      severity: row.severity,
      description: row.description,
      subjectId: row.subject_id,
      assetId: row.asset_id,
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
      observedAt: row.observed_at.toISOString(),
      ingestedAt: row.ingested_at.toISOString(),
      rawSha256: row.raw_sha256,
      trustLevel: row.trust_level,
      integrity: row.integrity,
      manifestSequence: row.manifest_sequence === null ? null : Number(row.manifest_sequence),
      transformerVersion: row.transformer_version,
      schemaVersion: row.schema_version,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(new Date(last.sort_at), last.id) : null,
  }
}

/** Full provenance for the evidence panel (§14). Raw source bytes are fetched separately. */
export async function getEvidenceDetail(trx: Tx, id: string) {
  const row = await trx
    .selectFrom("raw_evidence_objects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()
  if (!row) return null
  const [events, verifications, manifest, connector] = await Promise.all([
    trx
      .selectFrom("evidence_events")
      .select([
        "id",
        "event_type",
        "category",
        "severity",
        "description",
        "subject_type",
        "subject_id",
        "asset_type",
        "asset_id",
        "occurred_at",
        "time_confidence",
        "normalized_payload",
        "normalized_sha256",
        "schema_version",
        "transformer",
        "transformer_version",
        "created_at",
      ])
      .where("raw_object_id", "=", id)
      .orderBy("created_at", "desc")
      .execute(),
    trx
      .selectFrom("evidence_verifications")
      .select(["id", "result", "checks", "verified_by", "verified_at"])
      .where("raw_object_id", "=", id)
      .orderBy("verified_at", "desc")
      .limit(20)
      .execute(),
    trx
      .selectFrom("integrity_manifest_items as i")
      .innerJoin("integrity_manifests as m", "m.id", "i.manifest_id")
      .select([
        "m.id",
        "m.sequence",
        "m.merkle_root",
        "m.manifest_sha256",
        "m.signing_key_id",
        "m.period_start",
        "m.period_end",
        "m.item_count",
        "m.created_at",
        "i.leaf_index",
      ])
      .where("i.raw_object_id", "=", id)
      .executeTakeFirst(),
    row.connector_id
      ? trx
          .selectFrom("connectors")
          .select(["id", "display_name", "connector_type", "connector_version"])
          .where("id", "=", row.connector_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
  ])
  return {
    raw: row,
    events,
    verifications,
    manifest: manifest ?? null,
    connector: connector ?? null,
  }
}

export type EvidenceDetail = NonNullable<Awaited<ReturnType<typeof getEvidenceDetail>>>
