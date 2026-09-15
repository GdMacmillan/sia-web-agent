/**
 * Seed parity: every seed component's current `entry.ts` under
 * `components/` is byte-identical to its in-tree twin under
 * `src/components/seed/`, and the bundled registration names the version
 * the seed's `current` pointer selects.
 *
 * The twin is the never-break-boot fallback; a divergent copy would mean
 * two wrappers. `yarn sync:seed` refreshes the twins.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getProjectRoot } from "../../../src/utils/path-utils.js";
import { SEED_EXECUTE_CODE_VERSION } from "../../../src/middleware/code-execution.js";

const repoRoot = getProjectRoot();
const seedRoot = path.join(repoRoot, "components");
const twinRoot = path.join(repoRoot, "src", "components", "seed");

function currentVersion(componentDir: string): string {
  const current = path.join(componentDir, "current");
  if (lstatSync(current).isFile()) {
    return readFileSync(current, "utf-8").trim();
  }
  return path.basename(realpathSync(current));
}

function seedNames(): string[] {
  return readdirSync(seedRoot)
    .filter((name) => !name.startsWith("."))
    .filter((name) => lstatSync(path.join(seedRoot, name)).isDirectory())
    .sort();
}

describe("seed component twins", () => {
  it("ships execute-code as a seed component", () => {
    expect(seedNames()).toContain("execute-code");
  });

  it("keeps every twin byte-identical to the seed's current entry", () => {
    for (const name of seedNames()) {
      const version = currentVersion(path.join(seedRoot, name));
      const seedEntry = path.join(seedRoot, name, ".versions", version, "entry.ts");
      const twinEntry = path.join(twinRoot, name, "entry.ts");
      expect(existsSync(twinEntry)).toBe(true);
      const same = readFileSync(seedEntry, "utf-8") === readFileSync(twinEntry, "utf-8");
      if (!same) {
        throw new Error(
          `src/components/seed/${name}/entry.ts differs from components/${name}/.versions/${version}/entry.ts — run: yarn sync:seed`,
        );
      }
    }
  });

  it("has no twin without a seed", () => {
    const twins = readdirSync(twinRoot)
      .filter((name) => lstatSync(path.join(twinRoot, name)).isDirectory())
      .sort();
    expect(twins).toEqual(seedNames());
  });

  it("registers the bundled fallback under the seed's current version", () => {
    expect(currentVersion(path.join(seedRoot, "execute-code"))).toBe(
      SEED_EXECUTE_CODE_VERSION,
    );
  });
});
