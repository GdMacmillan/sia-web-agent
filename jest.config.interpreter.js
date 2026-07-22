import baseConfig from "./jest.config.js";

/**
 * Jest config for the vendored QuickJS code interpreter tests
 * (`tests/unit/code-interpreter/`).
 *
 * These are isolated from the main suite because the interpreter's runtime
 * dependencies — the QuickJS WASM module and prettier (pulled in by
 * json-schema-to-typescript) — perform dynamic `import()` at module-eval
 * time, which requires `NODE_OPTIONS=--experimental-vm-modules`. That flag
 * changes how other suites' dynamic imports resolve (e.g. @langchain/openrouter
 * fails to construct), so it must not be enabled for the default run. The
 * `test:interpreter` script sets the flag; this config narrows the run to the
 * interpreter tests only.
 *
 * WASM init on first eval is slow relative to a unit test, so the timeout is
 * raised well above jest's 5s default.
 */
export default {
  ...baseConfig,
  testMatch: ["**/tests/unit/code-interpreter/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 30000,
};
