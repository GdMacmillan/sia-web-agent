/**
 * On-disk component fixtures for the component tests.
 *
 * Builds `<root>/<name>/.versions/<version>/{component.json,entry.ts,contract.ts}`
 * plus the `current` link in a temp directory.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ComponentFixtureOptions {
  /** Manifest fields; `name`/`version` default from the arguments. */
  manifest?: Record<string, unknown>;
  /** Raw manifest text (overrides `manifest`, lets a test write invalid JSON). */
  manifestText?: string;
  /** Source of `entry.ts`; omitted = no entry file. */
  entry?: string;
  /** Source of `contract.ts`; omitted = no contract file. */
  contract?: string;
  /** Whether to create the `current` link (default true). */
  current?: boolean;
  /** Where `current` points, relative to the component dir (default `.versions/<version>`). */
  currentTarget?: string;
  /**
   * Write `current` as a one-line regular file naming the version instead
   * of a link (default false). `currentText` overrides the file content.
   */
  currentFile?: boolean;
  currentText?: string;
}

export interface ComponentFixture {
  componentDir: string;
  versionDir: string;
  manifestPath: string;
  entryPath: string;
  contractPath: string;
}

/** A temp directory that acts as a component root. */
export function makeRoot(prefix = "components-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Default manifest for `name@version`, `kind: service` unless overridden. */
export function baseManifest(
  name: string,
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    version,
    kind: "service",
    intent: "A test component.",
    sdk: "^1.0.0",
    lineage: { producedBy: "test" },
    ...overrides,
  };
}

/** Source of an entry that returns a service object with a `ping()`. */
export const SERVICE_ENTRY = `
export default function (deps: any) {
  return { ping: () => "pong", name: deps.manifest.name, sdk: deps.sdkVersion };
}
`;

/** Source of an entry that returns a middleware named by the manifest's `replaces`. */
export const MIDDLEWARE_ENTRY = `
export default function (deps: any) {
  return deps.createMiddleware({ name: deps.manifest.replaces ?? "componentMiddleware", tools: [] });
}
`;

/** Source of an entry that returns one tool named `component_echo`. */
export const TOOLS_ENTRY = `
export default function (deps: any) {
  const echo = deps.tool(
    async (input: any, config: any) =>
      \`echo:\${input.text}:\${config?.configurable?.thread_id ?? "none"}\`,
    {
      name: "component_echo",
      description: "Echo the input.",
      schema: deps.z.object({ text: deps.z.string() }),
    },
  );
  return [echo];
}
`;

/** Source of a contract that passes when the service pings. */
export const PASSING_CONTRACT = `
export default async function (deps: any) {
  if (deps.component.ping() !== "pong") throw new Error("ping did not pong");
}
`;

/** Source of a contract that throws. */
export const FAILING_CONTRACT = `
export default async function () {
  throw new Error("contract deliberately failed");
}
`;

/** Source of a contract that never resolves. */
export const HANGING_CONTRACT = `
export default function () {
  return new Promise(() => {});
}
`;

/** Write a component version (and optionally its `current` link) under `root`. */
export function writeComponent(
  root: string,
  name: string,
  version: string,
  options: ComponentFixtureOptions = {},
): ComponentFixture {
  const componentDir = path.join(root, name);
  const versionDir = path.join(componentDir, ".versions", version);
  mkdirSync(versionDir, { recursive: true });

  const manifestPath = path.join(versionDir, "component.json");
  const manifestText =
    options.manifestText ??
    JSON.stringify(baseManifest(name, version, options.manifest), null, 2);
  writeFileSync(manifestPath, manifestText);

  const entryPath = path.join(versionDir, "entry.ts");
  if (options.entry !== undefined) {
    writeFileSync(entryPath, options.entry);
  }
  const contractPath = path.join(versionDir, "contract.ts");
  if (options.contract !== undefined) {
    writeFileSync(contractPath, options.contract);
  }

  if (options.currentFile) {
    writeFileSync(
      path.join(componentDir, "current"),
      options.currentText ?? `${version}\n`,
    );
  } else if (options.current !== false) {
    const target = options.currentTarget ?? path.join(".versions", version);
    symlinkSync(target, path.join(componentDir, "current"), "dir");
  }

  return { componentDir, versionDir, manifestPath, entryPath, contractPath };
}

/** The plain importer for tests: a transformed absolute `.ts` path. */
export const plainImport = (absolutePath: string): Promise<unknown> =>
  import(absolutePath);
