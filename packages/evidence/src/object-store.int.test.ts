import { randomUUID } from "node:crypto"
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { beforeAll, describe, expect, it } from "vitest"
import {
  createS3ObjectStore,
  ObjectIntegrityError,
  ObjectNotFoundError,
  sha256Hex,
} from "./object-store"

const config = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  bucket: `test-${randomUUID().slice(0, 8)}`,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "platform-dev",
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "platform-dev-only",
  forcePathStyle: true,
}

beforeAll(async () => {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
})

describe("S3 object store (R2-compatible)", () => {
  it("writes once, accepts identical retries, refuses different content", async () => {
    const store = createS3ObjectStore(config)
    const key = `tenant/${randomUUID()}/raw/x.json`
    const body = Buffer.from(JSON.stringify({ source: "microsoft-entra", payload: { id: 1 } }))
    const sha256 = sha256Hex(body)

    expect(
      await store.putImmutable(key, body, { contentType: "application/json", sha256 }),
    ).toMatchObject({
      alreadyExisted: false,
      size: body.length,
    })
    expect(
      (await store.putImmutable(key, body, { contentType: "application/json", sha256 }))
        .alreadyExisted,
    ).toBe(true)

    const tampered = Buffer.from("tampered")
    await expect(
      store.putImmutable(key, tampered, {
        contentType: "application/json",
        sha256: sha256Hex(tampered),
      }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError)
    expect(sha256Hex(await store.get(key))).toBe(sha256)
    expect(await store.exists(key)).toBe(true)
  })

  it("reports missing objects", async () => {
    const store = createS3ObjectStore(config)
    await expect(store.get("missing/key.json")).rejects.toBeInstanceOf(ObjectNotFoundError)
    expect(await store.exists("missing/key.json")).toBe(false)
  })
})
