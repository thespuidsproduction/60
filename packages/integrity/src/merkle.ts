import { createHash } from "node:crypto"

/**
 * Merkle tree hashing per RFC 6962 §2.1 (dev bible §41).
 *
 *   leaf hash = SHA-256(0x00 || leaf data)
 *   node hash = SHA-256(0x01 || left || right)
 *   MTH(D[n]) splits at the largest power of two smaller than n.
 *
 * Domain separation between leaves and nodes prevents second-preimage attacks.
 * Leaf data for evidence is the UTF-8 string `<evidenceId>:<rawSha256>`,
 * binding each object's identity to its content.
 */
const sha256 = (...parts: Buffer[]) => {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest()
}
const LEAF = Buffer.from([0x00])
const NODE = Buffer.from([0x01])

export const MERKLE_ALGORITHM = "rfc6962-sha256"
export const LEAF_ENCODING = "utf8(evidenceId + ':' + rawSha256Hex)"

export function evidenceLeafData(evidenceId: string, rawSha256: string): Buffer {
  return Buffer.from(`${evidenceId}:${rawSha256}`, "utf8")
}

export const leafHash = (data: Buffer) => sha256(LEAF, data)
export const nodeHash = (left: Buffer, right: Buffer) => sha256(NODE, left, right)

function splitPoint(n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function rootOf(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha256()
  if (leaves.length === 1) return leaves[0]!
  const k = splitPoint(leaves.length)
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)))
}

/** Root over pre-hashed leaves (use `leafHash` on each leaf's data first). */
export function merkleRoot(leafHashes: Buffer[]): Buffer {
  return rootOf(leafHashes)
}

/** Audit path for leaf `index` (RFC 6962 §2.1.1), ordered leaf-to-root. */
export function inclusionProof(leafHashes: Buffer[], index: number): Buffer[] {
  if (index < 0 || index >= leafHashes.length) throw new RangeError("leaf index out of range")
  const path = (m: number, leaves: Buffer[]): Buffer[] => {
    if (leaves.length <= 1) return []
    const k = splitPoint(leaves.length)
    return m < k
      ? [...path(m, leaves.slice(0, k)), rootOf(leaves.slice(k))]
      : [...path(m - k, leaves.slice(k)), rootOf(leaves.slice(0, k))]
  }
  return path(index, leafHashes)
}

/** Verifies an audit path (RFC 9162 §2.1.3.2 algorithm). */
export function verifyInclusion(
  leaf: Buffer,
  index: number,
  treeSize: number,
  proof: Buffer[],
  root: Buffer,
): boolean {
  if (index < 0 || index >= treeSize) return false
  let fn = index
  let sn = treeSize - 1
  let r = leaf
  for (const p of proof) {
    if (sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1
          sn >>= 1
        }
      }
    } else {
      r = nodeHash(r, p)
    }
    fn >>= 1
    sn >>= 1
  }
  return sn === 0 && r.equals(root)
}
