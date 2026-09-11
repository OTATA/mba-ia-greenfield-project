import { registerAs } from '@nestjs/config';

/**
 * BullMQ / Redis connection plus the video-processing job policy.
 *
 * `processingAttempts` + `processingBackoffMs` keep transient FFmpeg failures
 * inside the queue: only a genuinely terminal failure (retries exhausted)
 * reaches the database as `status = failed`.
 */
export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  processingAttempts: parseInt(
    process.env.QUEUE_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  processingBackoffMs: parseInt(
    process.env.QUEUE_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
  // How long a row may sit in `uploading` before the janitor aborts it.
  abandonedUploadTtlMinutes: parseInt(
    process.env.QUEUE_ABANDONED_UPLOAD_TTL_MINUTES || '1440',
    10,
  ),
  janitorIntervalMs: parseInt(
    process.env.QUEUE_JANITOR_INTERVAL_MS || '900000',
    10,
  ),
}));
