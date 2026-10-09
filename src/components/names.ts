/**
 * Names shared between the component modules and the assembly site, kept
 * dependency-free so `agent.ts` can import them without pulling in the
 * registry.
 */

/** The middleware that refreshes active component manifests each turn. */
export const COMPONENTS_MIDDLEWARE_NAME = "componentsMiddleware";

/**
 * Tools that exist only because a bundled middleware provides them — they
 * are not part of the standard tool set. A component tool with one of
 * these names would collide at the model boundary, and the code-execution
 * tool API leaves them out (a script cannot delegate, load a skill, or
 * nest another execution).
 */
export const MIDDLEWARE_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_todos",
  "load_skill",
  "task",
  "execute_code",
  "eval",
]);

/**
 * Tool names the bundled middleware stack contributes: the middleware-only
 * tools plus the filesystem tools the filesystem middleware carries.
 */
export const MIDDLEWARE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MIDDLEWARE_ONLY_TOOL_NAMES,
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
]);
