#!/usr/bin/env node
/**
 * Copy each seed component's current `entry.ts` to its in-tree twin.
 *
 *   components/<name>/current            -> .versions/<version>   (a link, or a
 *                                           one-line file naming the version)
 *   components/<name>/.versions/<v>/entry.ts
 *     -> src/components/seed/<name>/entry.ts
 *
 * The twin is what the bundled registration evaluates when the on-disk seed
 * is absent or fails to load, so the two must stay byte-identical;
 * `tests/unit/components/seed-parity.test.ts` fails when they drift.
 *
 * Usage: node scripts/sync-seed-components.mjs [--check]
 *   --check  exit 1 instead of writing when a twin is out of date
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedRoot = path.join(repoRoot, "components");
const twinRoot = path.join(repoRoot, "src", "components", "seed");

/** Resolve `<componentDir>/current` to the version directory it names. */
export function resolveCurrentVersionDir(componentDir) {
  const current = path.join(componentDir, "current");
  if (lstatSync(current).isFile()) {
    const version = readFileSync(current, "utf-8").trim();
    return path.join(componentDir, ".versions", version);
  }
  return realpathSync(current);
}

/** Every `{ name, seedEntry, twinEntry }` pair under the seed root. */
export function listSeedPairs() {
  if (!existsSync(seedRoot)) {
    return [];
  }
  return readdirSync(seedRoot)
    .filter((name) => !name.startsWith("."))
    .filter((name) => lstatSync(path.join(seedRoot, name)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      seedEntry: path.join(resolveCurrentVersionDir(path.join(seedRoot, name)), "entry.ts"),
      twinEntry: path.join(twinRoot, name, "entry.ts"),
    }));
}

function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const { name, seedEntry, twinEntry } of listSeedPairs()) {
    const source = readFileSync(seedEntry, "utf-8");
    const current = existsSync(twinEntry) ? readFileSync(twinEntry, "utf-8") : null;
    if (current === source) {
      continue;
    }
    stale += 1;
    if (check) {
      console.error(`stale twin: ${path.relative(repoRoot, twinEntry)} (run: yarn sync:seed)`);
      continue;
    }
    mkdirSync(path.dirname(twinEntry), { recursive: true });
    writeFileSync(twinEntry, source);
    console.log(`synced ${name}: ${path.relative(repoRoot, seedEntry)} -> ${path.relative(repoRoot, twinEntry)}`);
  }
  if (check && stale > 0) {
    process.exit(1);
  }
  if (stale === 0) {
    console.log("seed twins are up to date");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
