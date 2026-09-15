/**
 * Carries a component middleware's `replaces` target on the middleware
 * object itself, as a non-enumerable symbol property, so the assembly site
 * can re-validate the target against the stack it actually builds without a
 * public type change.
 */

export const REPLACES_TAG: unique symbol = Symbol.for(
  "sia-web-agent.component.replaces",
);

/** Tag `middleware` with the name it stands in for. Returns the same object. */
export function tagReplaces<T extends object>(middleware: T, replaces: string): T {
  Object.defineProperty(middleware, REPLACES_TAG, {
    value: replaces,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return middleware;
}

/** Read the `replaces` target off a middleware, if it carries one. */
export function readReplaces(middleware: object): string | undefined {
  const value = (middleware as Record<symbol, unknown>)[REPLACES_TAG];
  return typeof value === "string" ? value : undefined;
}
