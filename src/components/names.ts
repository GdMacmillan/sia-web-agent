/**
 * Names shared between the component modules and the assembly site, kept
 * dependency-free so `agent.ts` can import them without pulling in the
 * registry.
 */

/** The middleware that refreshes active component manifests each turn. */
export const COMPONENTS_MIDDLEWARE_NAME = "componentsMiddleware";
