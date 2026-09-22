import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const TEST_SECRET = 'test-secret';

const STUB_HANDLER = jest.fn();
const STUB_CLASS = class {};

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => STUB_HANDLER,
    getClass: () => STUB_CLASS,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let mockReflector: { getAllAndOverride: jest.Mock };

  beforeAll(async () => {
    mockReflector = { getAllAndOverride: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    jwtService = module.get(JwtService);
  });

  beforeEach(() => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
  });

  it('bypasses guard on @Public() routes', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes with a valid JWT and attaches payload to request.user', async () => {
    const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((request.user as Record<string, unknown>)?.sub).toBe('user-1');
    expect((request.user as Record<string, unknown>)?.email).toBe(
      'a@example.com',
    );
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on malformed Bearer token', async () => {
    const ctx = makeContext({
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on expired JWT', async () => {
    const expiredToken = jwtService.sign(
      { sub: 'user-1', email: 'a@example.com' },
      { expiresIn: -60 },
    );
    const ctx = makeContext({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  /**
   * `@OptionalAuth()` exists because `@Public()` short-circuits before the
   * token is read, leaving `@CurrentUser()` undefined even for a caller who
   * did authenticate. Routes whose response depends on who is asking need the
   * identity without making it mandatory.
   */
  describe('on an @OptionalAuth() route', () => {
    beforeEach(() => {
      mockReflector.getAllAndOverride.mockImplementation(
        (key: string) => key === IS_OPTIONAL_AUTH_KEY,
      );
    });

    it('admits an anonymous caller and leaves request.user unset', async () => {
      const request: Record<string, unknown> = { headers: {} };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('attaches the payload when a valid token is presented', async () => {
      const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect((request.user as Record<string, unknown>)?.sub).toBe('user-1');
    });

    it('treats an invalid token as anonymous instead of rejecting', async () => {
      // The route works without credentials, so bad credentials must not be
      // worse than none — otherwise a stale token would break public browsing.
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer not-a-valid-jwt' },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });
  });
});
