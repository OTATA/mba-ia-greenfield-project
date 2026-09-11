import type { ArgumentsHost } from '@nestjs/common';

/** The response spies an exception-filter test asserts against. */
export interface ArgumentsHostMock {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
}

/**
 * A minimal HTTP `ArgumentsHost` for exception-filter unit tests.
 *
 * `ArgumentsHost` is a wide interface and filters only ever touch
 * `switchToHttp()`, so the object is built to satisfy that path and viewed
 * through the interface with a single cast — rather than each spec stubbing the
 * unused RPC/WS branches with `as any`.
 */
export function createArgumentsHostMock(
  request: { url: string; method: string } = { url: '/test', method: 'POST' },
): ArgumentsHostMock {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
    getArgs: () => [],
    getArgByIndex: () => null,
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
    getType: () => 'http',
  } as unknown as ArgumentsHost;

  return { host, status, json };
}
