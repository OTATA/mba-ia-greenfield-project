/** Queue that carries video-processing work from the API to the worker. */
export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

/** Job names on {@link VIDEO_PROCESSING_QUEUE}. */
export const VIDEO_JOBS = {
  /** Extract metadata, verify the upload, generate the thumbnail. */
  PROCESS: 'video.process',
  /** Periodic sweep that aborts uploads abandoned before `complete`. */
  UPLOAD_JANITOR: 'video.upload-janitor',
} as const;

/** MIME types accepted at create-upload (the admission half of TD-13). */
export const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
] as const;

/** 10 GiB — the ceiling the phase must support, in bytes. */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Retry policy for `video.process`.
 *
 * Transient trouble (storage hiccup, worker restart mid-job) is worth
 * retrying; exponential backoff keeps a struggling dependency from being
 * hammered. Verification failures are *not* retried — the processor settles
 * those terminally on the first attempt, because a file that is not a video
 * will not become one.
 */
export const VIDEO_PROCESS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
};
