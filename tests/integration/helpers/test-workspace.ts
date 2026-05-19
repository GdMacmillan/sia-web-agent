/**
 * Test Workspace Utilities for Integration Tests
 *
 * Creates isolated temporary workspaces for testing agents
 * without polluting the real filesystem.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { logger } from "../../../src/utils/logger.js";

export interface TestWorkspace {
  root: string;
  src: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary workspace with basic project structure
 */
export async function createTempWorkspace(): Promise<TestWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-"));

  // Create basic structure
  const src = path.join(root, "src");
  await fs.mkdir(src, { recursive: true });

  // Create minimal package.json
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "test-workspace",
        version: "1.0.0",
        type: "module",
        scripts: {
          test: 'echo "Test workspace"',
        },
      },
      null,
      2,
    ),
  );

  // Create tsconfig.json
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "node",
          esModuleInterop: true,
          strict: true,
          outDir: "./dist",
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
  );

  // Cleanup function
  const cleanup = async () => {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`Failed to cleanup workspace ${root}:`, error);
    }
  };

  return { root, src, cleanup };
}

/**
 * Create a workspace with sample files for testing RAG
 */
export async function createWorkspaceWithCode(): Promise<TestWorkspace> {
  const workspace = await createTempWorkspace();

  // Create sample TypeScript files
  await fs.writeFile(
    path.join(workspace.src, "calculator.ts"),
    `export class Calculator { add(a: number, b: number): number { return a + b; }

  subtract(a: number, b: number): number { return a - b; } }`,
  );

  await fs.writeFile(
    path.join(workspace.src, "utils.ts"),
    `export function validateNumber(n: unknown): number { if (typeof n !== 'number') { throw new
Error('Not a number'); } return n; }`,
  );

  return workspace;
}

/**
 * Verify a file exists and matches pattern
 */
export async function assertFileExists(
  workspace: string,
  pattern: RegExp,
): Promise<string | null> {
  const files = await getAllFiles(workspace);

  for (const file of files) {
    const relativePath = path.relative(workspace, file);
    if (pattern.test(relativePath)) {
      return file;
    }
  }

  return null;
}

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, dist, etc.
      if (!["node_modules", "dist", ".git"].includes(entry.name)) {
        files.push(...(await getAllFiles(fullPath)));
      }
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Count lines in a file
 */
export async function countFileLines(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath, "utf-8");
  return content.split("\n").length;
}

/**
 * Check if file contains text
 */
export async function fileContains(
  filePath: string,
  text: string,
): Promise<boolean> {
  const content = await fs.readFile(filePath, "utf-8");
  return content.includes(text);
}
