import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User } from '../users/entities/user.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from '../auth/entities/verification-token.entity';

/**
 * Entity builders for unit tests.
 *
 * Tests used to fake entities with `{ id: 'u1' } as any`, which erases the type
 * and cascades `no-unsafe-*` errors through every assertion that touches the
 * value. These builders return a fully-populated real entity instead, so the
 * mock's declared return type is satisfied and the compiler catches renamed or
 * removed columns in the fixtures themselves.
 *
 * Pass `overrides` for the fields the test actually cares about.
 */

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

export function buildUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.id = 'user-id';
  user.email = 'user@example.com';
  user.password = 'hashed-password';
  user.is_confirmed = false;
  user.created_at = EPOCH;
  user.updated_at = EPOCH;
  return Object.assign(user, overrides);
}

export function buildChannel(overrides: Partial<Channel> = {}): Channel {
  const channel = new Channel();
  channel.id = 'channel-id';
  channel.name = 'Channel Name';
  channel.nickname = 'channel-nickname';
  channel.description = null;
  channel.user_id = 'user-id';
  channel.created_at = EPOCH;
  channel.updated_at = EPOCH;
  return Object.assign(channel, overrides);
}

export function buildVerificationToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  const token = new VerificationToken();
  token.id = 'verification-token-id';
  token.token_hash = 'verification-token-hash';
  token.type = VerificationTokenType.EMAIL_CONFIRMATION;
  token.user_id = 'user-id';
  token.expires_at = new Date(EPOCH.getTime() + 60 * 60 * 1000);
  token.used_at = null;
  token.created_at = EPOCH;
  return Object.assign(token, overrides);
}

export function buildRefreshToken(
  overrides: Partial<RefreshToken> = {},
): RefreshToken {
  const token = new RefreshToken();
  token.id = 'refresh-token-id';
  token.token_hash = 'refresh-token-hash';
  token.family = 'token-family';
  token.user_id = 'user-id';
  token.expires_at = new Date(EPOCH.getTime() + 7 * 24 * 60 * 60 * 1000);
  token.revoked_at = null;
  token.created_at = EPOCH;
  return Object.assign(token, overrides);
}
