import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import storageConfig from '../../config/storage.config';
import type { ConfigType } from '@nestjs/config';

/** One planned part of a multipart upload, with its presigned URL. */
export interface PresignedUploadPart {
  part_number: number;
  url: string;
  content_length: number;
}

/** `{ PartNumber, ETag }` as the client reports it back after uploading. */
export interface CompletedPart {
  part_number: number;
  etag: string;
}

@Injectable()
export class StorageService {
  /** Server-side operations: reachable only inside the Compose network. */
  private readonly internalClient: S3Client;

  /**
   * Signing-only client. SigV4 signs the `Host` header, so a presigned URL is
   * valid **only** at the host it was signed for and cannot be rewritten
   * afterwards. Anything a browser will fetch must be signed by this client.
   */
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    // forcePathStyle is required for MinIO: without it the SDK builds
    // virtual-hosted-style URLs (bucket.host) that MinIO does not serve.
    this.internalClient = new S3Client({
      endpoint: config.internalEndpoint,
      region: config.region,
      credentials,
      forcePathStyle: true,
    });
    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      credentials,
      forcePathStyle: true,
    });
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  get uploadPartSizeBytes(): number {
    return this.config.uploadPartSizeBytes;
  }

  get presignedUrlTtlSeconds(): number {
    return this.config.presignedUrlTtlSeconds;
  }

  // ---------------------------------------------------------------- multipart

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(
        'Storage did not return an UploadId for the multipart upload',
      );
    }
    return result.UploadId;
  }

  /**
   * Plans the parts for `totalBytes` and presigns one URL per part.
   *
   * Each URL is bound to its exact `content-length` via `signableHeaders`. That
   * binding is what enforces the size ceiling: a client cannot upload a part
   * larger than planned (signature fails) nor add unplanned parts (unsigned).
   */
  async presignUploadParts(
    key: string,
    uploadId: string,
    totalBytes: number,
  ): Promise<PresignedUploadPart[]> {
    const partSize = this.uploadPartSizeBytes;
    const parts: PresignedUploadPart[] = [];
    let remaining = totalBytes;
    let partNumber = 1;

    while (remaining > 0) {
      const contentLength = Math.min(partSize, remaining);
      const url = await getSignedUrl(
        this.publicClient,
        new UploadPartCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: contentLength,
        }),
        {
          expiresIn: this.presignedUrlTtlSeconds,
          signableHeaders: new Set(['content-length']),
        },
      );
      parts.push({
        part_number: partNumber,
        url,
        content_length: contentLength,
      });
      remaining -= contentLength;
      partNumber += 1;
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.part_number - b.part_number)
            .map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Used by the janitor sweep to confirm an abort actually took effect. */
  async listMultipartUploadIds(): Promise<string[]> {
    const result = await this.internalClient.send(
      new ListMultipartUploadsCommand({ Bucket: this.videosBucket }),
    );
    return (result.Uploads ?? [])
      .map((u) => u.UploadId)
      .filter((id): id is string => Boolean(id));
  }

  // ------------------------------------------------------------------ reading

  /**
   * Short-lived presigned GET for playback. The client issues its own `Range`
   * requests against this URL and storage answers `206` natively — no range
   * handling exists in the API.
   */
  async presignPlaybackUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.videosBucket, Key: key }),
      { expiresIn: this.presignedUrlTtlSeconds },
    );
  }

  /** Same primitive as playback, differing only by the attachment override. */
  async presignDownloadUrl(key: string, filename: string): Promise<string> {
    const safeName = filename.replace(/["\\\r\n]/g, '');
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.videosBucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: this.presignedUrlTtlSeconds },
    );
  }

  /** True byte size of the stored object — the verification half of TD-13. */
  async headObjectSize(key: string): Promise<number> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.videosBucket, Key: key }),
    );
    return result.ContentLength ?? 0;
  }

  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.videosBucket, Key: key }),
    );
    return result.Body as Readable;
  }

  // ------------------------------------------------------------------ writing

  async putThumbnail(key: string, body: Buffer): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.thumbnailsBucket,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
  }

  async deleteVideoObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.videosBucket, Key: key }),
    );
  }
}
