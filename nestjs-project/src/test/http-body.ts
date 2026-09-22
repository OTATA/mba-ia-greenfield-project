import type { Response } from 'supertest';

/**
 * Supertest types `Response.body` as `any`, so every `res.body.foo` assertion
 * cascades `no-unsafe-member-access`. Reading the body through this helper
 * names the shape the endpoint is contracted to return, which both silences the
 * rule and makes the assertion fail to compile if the DTO is renamed.
 */
export function body<T>(res: Response): T {
  return res.body as T;
}

/** Shape produced by `DomainExceptionFilter` / `ValidationExceptionFilter`. */
export interface ErrorBody {
  error: string;
  message?: string | string[];
  statusCode?: number;
}

/** `POST /auth/login` and `POST /auth/refresh`. */
export interface AuthTokensBody {
  access_token: string;
  refresh_token: string;
}

/** `POST /auth/register`. */
export interface RegisteredUserBody {
  id: string;
  email: string;
}

/** `GET /auth/me` — the decoded JWT payload. */
export interface AuthProfileBody {
  sub: string;
  email: string;
}

/** `POST /videos` — the client's upload instructions. */
export interface CreatedUploadBody {
  public_id: string;
  upload_id: string;
  part_size: number;
  parts: { part_number: number; url: string; content_length: number }[];
}
