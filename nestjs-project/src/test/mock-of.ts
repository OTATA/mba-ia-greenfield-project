/**
 * Typed mock of a collaborator class, for use with `useValue` in unit tests.
 *
 * Deliberately **not** `jest.Mocked<T>`. That built-in intersects the mapped
 * type with `T` itself (`{ ...mapped } & T`), so the original *method*
 * declarations survive on the resulting type — and `expect(mock.someMethod)`,
 * the standard Jest assertion form, then trips
 * `@typescript-eslint/unbound-method`.
 *
 * A plain mapped type produces function-valued *properties* instead, which the
 * rule correctly ignores (a property holds no `this`), while still carrying the
 * precise argument and return types so `mockResolvedValue` stays type-checked.
 */
export type MockOf<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : T[K];
};
