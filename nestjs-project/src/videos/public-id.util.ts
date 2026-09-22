import { randomBytes } from 'node:crypto';

/**
 * The public id is the only video identifier that ever appears in a URL. It is
 * deliberately not the primary key: a sequential or guessable id would let
 * anyone enumerate the catalogue, and exposing the PK couples public URLs to
 * the storage layout.
 *
 * 8 random bytes encode to 11 base64url characters — comfortably inside the
 * `varchar(16)` column, and 2^64 of keyspace, so a collision is a curiosity
 * rather than a design concern. The retry below exists because "improbable" is
 * not "impossible", and a unique-constraint violation at insert time would
 * otherwise surface to the user as a 500.
 */
const PUBLIC_ID_BYTES = 8;

/** Attempts before giving up; a second collision already means something is wrong. */
const MAX_ATTEMPTS = 5;

export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}

/**
 * Draws public ids until one is free.
 *
 * Takes the availability check as a parameter rather than a repository so the
 * retry logic stays free of persistence concerns and can be exercised without
 * a database.
 *
 * @param isTaken - resolves true when the candidate is already in use
 */
export async function generateUniquePublicId(
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generatePublicId();
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not generate a free public id after ${maxAttempts} attempts`,
  );
}
