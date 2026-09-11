import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * The subset of `SelectQueryBuilder` the services actually drive when they
 * issue bulk updates (revoking a token family, invalidating stale tokens).
 *
 * Declared as function-valued *properties* rather than methods so that
 * `expect(qb.execute).toHaveBeenCalled()` does not trip
 * `@typescript-eslint/unbound-method` — same reasoning as `MockOf`.
 */
export type QueryBuilderMock = {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
};

/** A query-builder mock whose chainable methods return the builder itself. */
export function buildQueryBuilderMock(): QueryBuilderMock {
  const qb: QueryBuilderMock = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue(undefined),
  };

  qb.update.mockReturnValue(qb);
  qb.set.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);

  return qb;
}

/**
 * Views the mock through TypeORM's builder type so it can be handed to a
 * `createQueryBuilder` mock. Keeps the single unavoidable cast in one place
 * instead of one `as any` per call site.
 */
export function asQueryBuilder<T extends ObjectLiteral>(
  qb: QueryBuilderMock,
): SelectQueryBuilder<T> {
  return qb as unknown as SelectQueryBuilder<T>;
}
