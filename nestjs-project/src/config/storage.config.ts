import { registerAs } from '@nestjs/config';

/**
 * Two endpoints, deliberately.
 *
 * SigV4 signs the `Host` header, so a presigned URL is only valid at the exact
 * host it was signed for and cannot be rewritten afterwards. Server-side calls
 * (worker reads, CompleteMultipartUpload, HeadObject) go through
 * `internalEndpoint`, which is the Compose service name. Anything a browser
 * will fetch is signed against `publicEndpoint`.
 *
 * A `localhost`-based `publicEndpoint` in development does NOT violate the root
 * CLAUDE.md Docker-host rule: that rule governs container-to-container
 * configuration, while this value is a browser-facing URL. In production both
 * become the real S3 or CDN hostname.
 */
export default registerAs('storage', () => ({
  internalEndpoint: process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY || 'streamtube',
  secretAccessKey: process.env.S3_SECRET_KEY || 'streamtube',
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  uploadPartSizeBytes: parseInt(
    process.env.S3_UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  presignedUrlTtlSeconds: parseInt(
    process.env.S3_PRESIGNED_URL_TTL_SECONDS || '1800',
    10,
  ),
}));
