import * as path from 'node:path';

/**
 * Object keys are derived from the **internal** `videoId`, never from the
 * public URL id. That keeps storage stable if the public id is ever rotated,
 * and it keeps the public id out of the storage namespace.
 */

/** Anything outside this set is dropped from a filename-derived extension. */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;

/**
 * Extracts a safe, lowercase extension from a client-supplied filename.
 * Returns an empty string when the filename has no usable extension — the key
 * is then simply `original`, which storage handles fine.
 */
export function safeExtensionFrom(filename: string): string {
  const ext = path.extname(filename ?? '').toLowerCase();
  return SAFE_EXTENSION.test(ext) ? ext : '';
}

/** `videos/{videoId}/original{ext}` — lives in the private bucket. */
export function videoObjectKey(videoId: string, filename: string): string {
  return `videos/${videoId}/original${safeExtensionFrom(filename)}`;
}

/** `thumbnails/{videoId}/frame.jpg` — lives in the public-read bucket. */
export function thumbnailObjectKey(videoId: string): string {
  return `thumbnails/${videoId}/frame.jpg`;
}

/**
 * Stable, unsigned URL for a thumbnail. The thumbnails bucket is public-read
 * precisely so listings do not pay one signature per item, so this is a plain
 * path-style URL against the public endpoint.
 */
export function thumbnailPublicUrl(
  publicEndpoint: string,
  bucket: string,
  thumbnailKey: string,
): string {
  return `${publicEndpoint.replace(/\/+$/, '')}/${bucket}/${thumbnailKey}`;
}
