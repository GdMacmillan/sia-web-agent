import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load environment variables from local .env (single-repo standalone)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, ".env") });

/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // estree-walker@3 (a vendored code-interpreter dep) exposes only an
    // "import" export condition — no "default"/"require" — so jest's node
    // resolver can't find it. Point straight at its ESM entry; it's
    // allowlisted in transformIgnorePatterns so babel-jest transpiles it.
    "^estree-walker$": "<rootDir>/node_modules/estree-walker/src/index.js",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "esnext",
          target: "ES2022",
          lib: ["ES2023"],
          moduleResolution: "nodenext",
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          // ts-jest internally hardcodes ModuleResolutionKind.Node10 which is
          // deprecated in TS6. Suppress TS5107 until ts-jest removes it.
          ignoreDeprecations: "6.0",
        },
      },
    ],
    "^.+\\.m?js$": "babel-jest",
  },
  testMatch: ["**/tests/**/*.test.ts", "**/*.test.ts"],
  // Code-interpreter tests live in their own flagged run (jest.config.interpreter.js,
  // via `yarn test:interpreter`) because the QuickJS WASM + prettier deps need
  // NODE_OPTIONS=--experimental-vm-modules, which breaks other suites' dynamic
  // imports. Keep them out of the default run.
  testPathIgnorePatterns: ["/node_modules/", "tests/unit/code-interpreter/"],
  transformIgnorePatterns: [
    // ESM-only packages that must be transformed rather than ignored.
    // The trailing group covers the vendored QuickJS code interpreter's
    // pure-ESM deps (src/code-interpreter/): the acorn TS plugin, the
    // p-queue concurrency chain, and the AST/string transform libs.
    "node_modules/(?!.pnpm|@langchain|langchain|p-retry|is-network-error|decamelize|camelcase|@sveltejs|p-queue|p-timeout|eventemitter3|estree-walker|magic-string|dedent)",
  ],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  coverageThreshold: {
    "./src/tools/search-tool.ts": {
      statements: 60,
      branches: 50,
      functions: 60,
      lines: 60,
    },
    "./src/middleware/skills.ts": {
      statements: 60,
      branches: 60,
      functions: 60,
      lines: 60,
    },
    "./src/tools/context-tools.ts": {
      statements: 60,
      branches: 60,
      functions: 60,
      lines: 60,
    },
    "./src/deep-agent-setup.ts": {
      statements: 60,
      branches: 50,
      functions: 60,
      lines: 60,
    },
  },
  globalTeardown: "./tests/integration/global-teardown.ts",
  verbose: true,
  maxWorkers: "50%",
};
