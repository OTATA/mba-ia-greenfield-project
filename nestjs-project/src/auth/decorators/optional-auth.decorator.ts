import { SetMetadata } from '@nestjs/common';

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';

/**
 * Lets a route be reached anonymously **and** still know the caller when a
 * valid token is presented.
 *
 * `@Public()` is not enough for this: it short-circuits the guard before the
 * token is read, so `@CurrentUser()` is always undefined on a public route.
 * Endpoints whose *response* depends on who is asking — a video visible to its
 * owner while unpublished, hidden from everyone else — need the identity
 * without making it mandatory.
 *
 * An invalid or expired token is treated as anonymous rather than rejected:
 * the route works without credentials, so bad credentials must not be worse
 * than none.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
