import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { inclusionProof, leafHash, merkleRoot, nodeHash, verifyInclusion } from "./merkle"
import {
  generateSigningKey,
  createManifestSigner,
  parseSigningKeyRing,
  verifySignature,
} from "./signing"

const leaves = (n: number) =>
  Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`leaf-${i}`)))

describe("RFC 6962 Merkle tree", () => {
  it("matches the RFC definitions for small trees", () => {
    expect(merkleRoot([]).toString("hex")).toBe(createHash("sha256").digest("hex"))
    const [a, b, c] = leaves(3) as [Buffer, Buffer, Buffer]
    expect(merkleRoot([a]).equals(a)).toBe(true)
    expect(merkleRoot([a, b]).equals(nodeHash(a, b))).toBe(true)
    // n=3 splits at k=2: node(node(a,b), c)
    expect(merkleRoot([a, b, c]).equals(nodeHash(nodeHash(a, b), c))).toBe(true)
    // leaf/node domain separation
    expect(leafHash(Buffer.concat([a, b])).equals(nodeHash(a, b))).toBe(false)
  })

  it("produces verifiable inclusion proofs for every leaf of trees up to 33 leaves", () => {
    for (let n = 1; n <= 33; n++) {
      const tree = leaves(n)
      const root = merkleRoot(tree)
      for (let i = 0; i < n; i++) {
        const proof = inclusionProof(tree, i)
        expect(verifyInclusion(tree[i]!, i, n, proof, root)).toBe(true)
        expect(verifyInclusion(leafHash(Buffer.from("forged")), i, n, proof, root)).toBe(false)
        if (n > 1) expect(verifyInclusion(tree[i]!, (i + 1) % n, n, proof, root)).toBe(false)
      }
    }
  })

  it("changes the root when any leaf or the order changes", () => {
    const tree = leaves(8)
    const root = merkleRoot(tree).toString("hex")
    expect(merkleRoot([...tree].reverse()).toString("hex")).not.toBe(root)
    const altered = [...tree]
    altered[5] = leafHash(Buffer.from("tampered"))
    expect(merkleRoot(altered).toString("hex")).not.toBe(root)
  })
})

describe("Ed25519 manifest signing", () => {
  it("signs and verifies; rejects other keys and altered messages", () => {
    const k1 = generateSigningKey("k1")
    const k2 = generateSigningKey("k2")
    const signer = createManifestSigner(`${k1.id}:${k1.privateKeyPkcs8}`)
    const message = Buffer.from('{"manifest":1}')
    const signature = signer.sign(message)
    expect(signer.publicKey).toBe(k1.publicKey)
    expect(verifySignature(k1.publicKey, message, signature)).toBe(true)
    expect(verifySignature(k2.publicKey, message, signature)).toBe(false)
    expect(verifySignature(k1.publicKey, Buffer.from('{"manifest":2}'), signature)).toBe(false)
    expect(verifySignature("not-a-key", message, signature)).toBe(false)
  })

  it("uses the first key of the ring and validates entries", () => {
    const k1 = generateSigningKey("k1")
    const k2 = generateSigningKey("k2")
    expect(createManifestSigner(`k2:${k2.privateKeyPkcs8},k1:${k1.privateKeyPkcs8}`).keyId).toBe(
      "k2",
    )
    expect(() => parseSigningKeyRing("")).toThrow()
    expect(() => parseSigningKeyRing(`k1:${k1.privateKeyPkcs8},k1:${k2.privateKeyPkcs8}`)).toThrow(
      /Duplicate/,
    )
    expect(() => parseSigningKeyRing("BAD ID:abc")).toThrow()
    expect(() => parseSigningKeyRing(`--:${k1.privateKeyPkcs8}`)).toThrow()
    expect(() => generateSigningKey("--")).toThrow()
  })
})
