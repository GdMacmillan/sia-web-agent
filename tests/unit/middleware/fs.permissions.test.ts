/**
 * Filesystem permissions — fork-adapted.
 *
 * Adapted from upstream deepagents (libs/deepagents/src/middleware/fs.permissions.test.ts).
 * The fork's fs tools resolve state via `getCurrentTaskInput`, which only works
 * inside a running graph, so the result-filtering tools (ls/glob/grep) can't be
 * driven standalone here — their filtering is `filterByPermissions`, whose
 * decision logic (`decidePathAccess`) is exhaustively covered in
 * tests/unit/permissions/enforce.test.ts.
 *
 * These tests cover the security-critical write/read gates (checkPermission),
 * which run BEFORE any state/backend access, plus the setup-time path
 * validation and the `enabledTools` allowlist.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createFilesystemMiddleware,
  createFilesystemTools,
} from "../../../src/middleware/fs.js";
import { StateBackend } from "../../../src/backends/state.js";
import type { FilesystemPermission } from "../../../src/permissions/index.js";

function toolsWith(permissions: FilesystemPermission[]) {
  // A StateBackend instance is returned as-is by the tools (no factory), so
  // permission denials — which run first — never reach state resolution.
  const backend = new StateBackend({ state: { files: {} } });
  const tools = createFilesystemTools(backend, { permissions });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return byName as Record<string, (typeof tools)[number]>;
}

describe("filesystem permissions — write/read gate", () => {
  it("allows read when no rules are configured (allow-all default)", async () => {
    const tools = toolsWith([]);
    const out = await tools.read_file.invoke({
      file_path: "/anything.txt",
      offset: 0,
      limit: 2000,
    });
    // No permission error; failure (if any) comes from the backend, not the gate.
    expect(String(out)).not.toContain("permission denied");
  });

  it("denies read on a matched deny rule before touching the backend", async () => {
    const tools = toolsWith([
      { operations: ["read"], paths: ["/secrets/**"], mode: "deny" },
    ]);
    const out = await tools.read_file.invoke({
      file_path: "/secrets/key.txt",
      offset: 0,
      limit: 2000,
    });
    expect(String(out)).toContain("permission denied for read on /secrets/key.txt");
  });

  it("denies write on a matched deny rule", async () => {
    const tools = toolsWith([
      { operations: ["write"], paths: ["/etc/**"], mode: "deny" },
    ]);
    const out = await tools.write_file.invoke({
      file_path: "/etc/passwd",
      content: "x",
    });
    expect(String(out)).toContain("permission denied for write on /etc/passwd");
  });

  it("denies edit on a matched write deny rule", async () => {
    const tools = toolsWith([
      { operations: ["write"], paths: ["/etc/**"], mode: "deny" },
    ]);
    const out = await tools.edit_file.invoke({
      file_path: "/etc/hosts",
      old_string: "a",
      new_string: "b",
      replace_all: false,
    });
    expect(String(out)).toContain("permission denied for write on /etc/hosts");
  });

  it("a read deny rule does not block writes to the same path", async () => {
    const tools = toolsWith([
      { operations: ["read"], paths: ["/data/**"], mode: "deny" },
    ]);
    const out = await tools.write_file.invoke({
      file_path: "/data/out.txt",
      content: "x",
    });
    // Write is permitted (rule only governs "read"); no permission error.
    expect(String(out)).not.toContain("permission denied");
  });

  it("rejects a non-absolute path as a recoverable error", async () => {
    const tools = toolsWith([
      { operations: ["read"], paths: ["/**"], mode: "deny" },
    ]);
    const out = await tools.read_file.invoke({
      file_path: "relative/path.txt",
      offset: 0,
      limit: 2000,
    });
    expect(String(out)).toMatch(/Error:.*absolute/);
  });

  it("first-match-wins: an allow rule ahead of a deny-all permits the path", async () => {
    const tools = toolsWith([
      { operations: ["read"], paths: ["/workspace/**"] },
      { operations: ["read"], paths: ["/**"], mode: "deny" },
    ]);
    const out = await tools.read_file.invoke({
      file_path: "/workspace/a.ts",
      offset: 0,
      limit: 2000,
    });
    expect(String(out)).not.toContain("permission denied");
  });
});

describe("filesystem permissions — setup validation", () => {
  it("throws on a relative rule path at middleware creation", () => {
    expect(() =>
      createFilesystemMiddleware({
        permissions: [{ operations: ["read"], paths: ["relative/**"] }],
      }),
    ).toThrow(/absolute/);
  });

  it("throws on a rule path containing ..", () => {
    expect(() =>
      createFilesystemMiddleware({
        permissions: [{ operations: ["read"], paths: ["/foo/../bar"] }],
      }),
    ).toThrow(/\.\./);
  });

  it("accepts valid absolute rule paths", () => {
    expect(() =>
      createFilesystemMiddleware({
        permissions: [
          { operations: ["read", "write"], paths: ["/workspace/**"] },
        ],
      }),
    ).not.toThrow();
  });
});

describe("filesystem enabledTools allowlist", () => {
  const backend = new StateBackend({ state: { files: {} } });

  it("exposes all six tools when no allowlist is given", () => {
    const names = createFilesystemTools(backend).map((t) => t.name).sort();
    expect(names).toEqual(
      ["edit_file", "glob", "grep", "ls", "read_file", "write_file"].sort(),
    );
  });

  it("restricts to the allowlist", () => {
    const names = createFilesystemTools(backend, {
      enabledTools: ["ls", "grep"],
    }).map((t) => t.name);
    expect(names).toContain("ls");
    expect(names).toContain("grep");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
  });

  it("always includes read_file even when omitted from the allowlist", () => {
    const names = createFilesystemTools(backend, {
      enabledTools: ["ls"],
    }).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("ls");
  });
});
