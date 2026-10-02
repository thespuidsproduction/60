import { canonicalJson } from "@platform/shared"
import { sha256Hex } from "@platform/evidence"
import type { LEAF_ENCODING, MERKLE_ALGORITHM } from "./merkle"
import { evidenceLeafData, leafHash, merkleRoot } from "./merkle"

/**
 * Integrity manifest document (dev bible §41). Serialised as canonical JSON;
 * the SHA-256 of those exact bytes is the manifest hash, which the next
 * manifest in the tenant's chain references, and the Ed25519 signature covers
 * the same bytes.
 */
export interface ManifestItem {
  id: string
  reference: string
  hash: string
}

export interface ManifestDocument {
  manifestVersion: 1
  manifestId: string
  tenantId: string
  sequence: number
  source: string
  periodStart: string
  periodEnd: string
  merkleAlgorithm: typeof MERKLE_ALGORITHM
  leafEncoding: typeof LEAF_ENCODING
  items: ManifestItem[]
  merkleRoot: string
  previousManifestId: string | null
  previousManifestHash: string | null
  createdAt: string
  signingKeyId: string
}

export function computeMerkleRoot(items: Pick<ManifestItem, "id" | "hash">[]): string {
  return merkleRoot(items.map((item) => leafHash(evidenceLeafData(item.id, item.hash)))).toString(
    "hex",
  )
}

export function serialiseManifest(document: ManifestDocument): Buffer {
  return Buffer.from(canonicalJson(document), "utf8")
}

export function manifestHash(bytes: Buffer): string {
  return sha256Hex(bytes)
}
