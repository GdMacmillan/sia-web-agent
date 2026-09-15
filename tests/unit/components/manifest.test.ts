/**
 * Component manifest schema and directory-convention rules.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ComponentManifestSchema,
  parseComponentManifest,
} from "../../../src/components/manifest.js";
import { baseManifest } from "./fixtures.js";

const ctx = { dirName: "hello", versionDirName: "0.1.0" };

describe("ComponentManifestSchema", () => {
  it("applies the entry/contract/depth defaults", () => {
    const parsed = ComponentManifestSchema.parse(baseManifest("hello", "0.1.0"));
    expect(parsed.entry).toBe("entry.ts");
    expect(parsed.contract).toBe("contract.ts");
    expect(parsed.depth).toBe(0);
  });

  it("rejects unknown keys (strict)", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "0.1.0", { registry: "somewhere" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown lineage keys (strict)", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "0.1.0", {
        lineage: { producedBy: "test", extra: 1 },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("requires lineage.producedBy", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "0.1.0", { lineage: {} }),
    );
    expect(result.success).toBe(false);
  });

  it.each(["Hello", "1abc", "hello_world", "-x", ""])(
    "rejects the name %j",
    (name) => {
      const result = ComponentManifestSchema.safeParse(
        baseManifest(name, "0.1.0"),
      );
      expect(result.success).toBe(false);
    },
  );

  it("rejects an invalid semver version", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "latest"),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an invalid sdk range", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "0.1.0", { sdk: "not a range" }),
    );
    expect(result.success).toBe(false);
  });

  it.each(["/abs/entry.ts", "../entry.ts", "a/../b.ts", ""])(
    "rejects the entry reference %j",
    (entry) => {
      const result = ComponentManifestSchema.safeParse(
        baseManifest("hello", "0.1.0", { entry }),
      );
      expect(result.success).toBe(false);
    },
  );

  it("rejects a negative or fractional depth", () => {
    expect(
      ComponentManifestSchema.safeParse(
        baseManifest("hello", "0.1.0", { depth: -1 }),
      ).success,
    ).toBe(false);
    expect(
      ComponentManifestSchema.safeParse(
        baseManifest("hello", "0.1.0", { depth: 1.5 }),
      ).success,
    ).toBe(false);
  });

  it("validates profile strictly", () => {
    const result = ComponentManifestSchema.safeParse(
      baseManifest("hello", "0.1.0", { profile: { bogus: true } }),
    );
    expect(result.success).toBe(false);
  });
});

describe("parseComponentManifest", () => {
  it("accepts a minimal manifest matching its directories", () => {
    const result = parseComponentManifest(baseManifest("hello", "0.1.0"), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("hello");
      expect(result.profile).toBeUndefined();
    }
  });

  it("reports schema failures with the field path", () => {
    const result = parseComponentManifest(
      baseManifest("hello", "0.1.0", { kind: "plugin" }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("kind");
    }
  });

  it("rejects a name that differs from the directory name", () => {
    const result = parseComponentManifest(
      baseManifest("other", "0.1.0"),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match directory name/);
    }
  });

  it("rejects a version that differs from the version directory", () => {
    const result = parseComponentManifest(
      baseManifest("hello", "0.2.0"),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match version directory/);
    }
  });

  it("rejects replaces on a non-middleware kind", () => {
    const result = parseComponentManifest(
      baseManifest("hello", "0.1.0", {
        kind: "tools",
        replaces: "CodeExecutionMiddleware",
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/only valid for kind "middleware"/);
    }
  });

  it("constructs the profile when present", () => {
    const result = parseComponentManifest(
      baseManifest("hello", "0.1.0", {
        profile: { excludedTools: ["web_search"], systemPromptSuffix: "Be brief." },
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile?.excludedTools.has("web_search")).toBe(true);
      expect(result.profile?.systemPromptSuffix).toBe("Be brief.");
    }
  });

  it("treats a required-middleware exclusion in profile as a parse failure", () => {
    const result = parseComponentManifest(
      baseManifest("hello", "0.1.0", {
        profile: { excludedMiddleware: ["FilesystemMiddleware"] },
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid profile/);
    }
  });

  it("never lets a poisoned profile key through", () => {
    const raw = baseManifest("hello", "0.1.0", {
      profile: JSON.parse('{"__proto__": {"x": 1}}'),
    });
    let result: ReturnType<typeof parseComponentManifest> | undefined;
    expect(() => {
      result = parseComponentManifest(raw, ctx);
    }).not.toThrow();
    if (result?.ok) {
      expect(Object.getPrototypeOf(result.profile)).toBe(Object.prototype);
      expect("x" in (result.profile as object)).toBe(false);
    }
  });

  it("never throws on garbage input", () => {
    expect(parseComponentManifest(null, ctx).ok).toBe(false);
    expect(parseComponentManifest("nope", ctx).ok).toBe(false);
    expect(parseComponentManifest(42, ctx).ok).toBe(false);
  });
});
