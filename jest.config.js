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
  testPathIgnorePatterns: ["/node_modules/"],
  transformIgnorePatterns: [
    "node_modules/(?!.pnpm|@langchain|langchain|p-retry|is-network-error|decamelize|camelcase)",
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
