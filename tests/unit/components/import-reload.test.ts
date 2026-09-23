/**
 * `defaultImportModule` re-imports a file the agent has just edited (the
 * contract runner loads a candidate's entry and contract on every run).
 * That only works if the TypeScript loader keeps the cache-busting query on
 * a `.ts` URL; a loader that drops it hands back the first-loaded module and
 * every later run replays the first result. This runs the real importer
 * under the repo's own tsx loader, in a child process, and asserts that the
 * second load of an edited file sees the edit.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const tsxLoader = createRequire(path.join(repoRoot, "package.json")).resolve("tsx");
const loaderSource = path.join(repoRoot, "src", "components", "loader.ts");

const dir = mkdtempSync(path.join(tmpdir(), "import-reload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("defaultImportModule", () => {
  it("sees an edit to a .ts file on the next import", () => {
    const mod = path.join(dir, "mod.ts");
    writeFileSync(mod, "export const value: number = 1;\n");

    const runner = path.join(dir, "runner.mts");
    writeFileSync(
      runner,
      [
        'import { writeFileSync } from "node:fs";',
        `const { defaultImportModule } = await import(${JSON.stringify(pathToFileURL(loaderSource).href)});`,
        `const mod = ${JSON.stringify(mod)};`,
        "const first = ((await defaultImportModule(mod)) as { value: number }).value;",
        'writeFileSync(mod, "export const value: number = 2;\\n");',
        "const second = ((await defaultImportModule(mod)) as { value: number }).value;",
        "console.log(JSON.stringify({ first, second }));",
      ].join("\n"),
    );

    const out = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, runner], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(out.status).toBe(0);
    const last = out.stdout.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(last)).toEqual({ first: 1, second: 2 });
  });
});
