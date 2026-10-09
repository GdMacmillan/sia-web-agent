/**
 * Timeout bounds for the `execute_code` tool. Kept dependency-free so the
 * component SDK and the bundled middleware can both import them without a
 * cycle.
 */

/** Default timeout for code execution (60 seconds) */
export const DEFAULT_TIMEOUT_MS = 60000;

/** Maximum timeout for code execution (5 minutes) */
export const MAX_TIMEOUT_MS = 300000;
