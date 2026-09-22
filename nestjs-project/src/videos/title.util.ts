import * as path from 'node:path';

/** Matches the `title` column width. */
const MAX_TITLE_LENGTH = 255;

/** Used when the filename carries no usable name (e.g. `.mp4`, `   `). */
const FALLBACK_TITLE = 'Untitled video';

/**
 * Derives the initial video title from the uploaded filename.
 *
 * The phase has no title field in the upload request — the title is seeded
 * from the filename and becomes editable in Phase 04. The column is
 * `not null`, so this must always return a non-empty string, which is why the
 * fallback exists rather than letting an empty name reach the insert.
 */
/**
 * Rebuilds a human-friendly filename for the `attachment` disposition.
 *
 * The original client filename is not stored — only the title derived from it
 * and the object key, which carries the extension. Recombining the two gives
 * the user a sensible name that also tracks a title edited in a later phase.
 */
export function downloadFilename(title: string, storageKey: string): string {
  return `${title}${path.extname(storageKey)}`;
}

export function deriveTitleFromFilename(filename: string): string {
  const withoutExtension = path.basename(
    filename ?? '',
    path.extname(filename ?? ''),
  );
  const collapsed = withoutExtension.replace(/\s+/g, ' ').trim();

  if (collapsed.length === 0) {
    return FALLBACK_TITLE;
  }

  return collapsed.slice(0, MAX_TITLE_LENGTH);
}
