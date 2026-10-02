import { createHash } from "node:crypto"
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"

export interface PutResult {
  key: string
  sha256: string
  size: number
  /** The identical object already existed (idempotent retry). */
  alreadyExisted: boolean
}

export interface PutOptions {
  contentType: string
  /** Hex SHA-256 the caller computed; the store verifies the bytes against it. */
  sha256: string
}

/**
 * Write-once object storage for evidence (dev bible §50, §109).
 *
 * `putImmutable` never overwrites: a second write to the same key succeeds only
 * if the bytes are identical (retry), otherwise it fails loudly. Retention locks
 * are configured on the bucket (see docs/infrastructure.md).
 */
export interface ObjectStore {
  putImmutable(key: string, body: Buffer, options: PutOptions): Promise<PutResult>
  get(key: string): Promise<Buffer>
  exists(key: string): Promise<boolean>
}

export class ObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ObjectIntegrityError"
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`)
    this.name = "ObjectNotFoundError"
  }
}

export const sha256Hex = (body: Buffer | string) => createHash("sha256").update(body).digest("hex")

function assertDigest(body: Buffer, expected: string) {
  if (!/^[0-9a-f]{64}$/.test(expected))
    throw new ObjectIntegrityError("sha256 must be lowercase hex")
  if (sha256Hex(body) !== expected)
    throw new ObjectIntegrityError("Body does not match declared SHA-256")
}

export interface S3ObjectStoreConfig {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

/** S3-compatible implementation (Cloudflare R2 in production; SeaweedFS locally, D-001). */
export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "auto",
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  const Bucket = config.bucket

  const store: ObjectStore = {
    async putImmutable(key, body, options) {
      assertDigest(body, options.sha256)
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            // Storage verifies the bytes it received against our digest.
            ChecksumSHA256: Buffer.from(options.sha256, "hex").toString("base64"),
            // Conditional write: never replace an existing object.
            IfNoneMatch: "*",
            Metadata: { sha256: options.sha256 },
          }),
        )
        return { key, sha256: options.sha256, size: body.length, alreadyExisted: false }
      } catch (error) {
        const status =
          error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined
        if (status !== 412 && status !== 409) throw error
        const existing = await store.get(key)
        if (sha256Hex(existing) !== options.sha256) {
          throw new ObjectIntegrityError(`Refusing to overwrite ${key} with different content`)
        }
        return { key, sha256: options.sha256, size: body.length, alreadyExisted: true }
      }
    },

    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket, Key: key }))
        return Buffer.from(await response.Body!.transformToByteArray())
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          throw new ObjectNotFoundError(key)
        }
        throw error
      }
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }))
        return true
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
          return false
        throw error
      }
    },
  }
  return store
}

/** In-memory store with the same semantics, for unit tests and connector harnesses. */
export function createMemoryObjectStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  return {
    objects,
    async putImmutable(key, body, options) {
      assertDigest(body, options.sha256)
      const existing = objects.get(key)
      if (existing) {
        if (sha256Hex(existing) !== options.sha256) {
          throw new ObjectIntegrityError(`Refusing to overwrite ${key} with different content`)
        }
        return { key, sha256: options.sha256, size: body.length, alreadyExisted: true }
      }
      objects.set(key, Buffer.from(body))
      return { key, sha256: options.sha256, size: body.length, alreadyExisted: false }
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new ObjectNotFoundError(key)
      return Buffer.from(body)
    },
    async exists(key) {
      return objects.has(key)
    },
  }
}
