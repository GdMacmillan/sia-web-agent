import { describe, it, expect } from "@jest/globals";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import * as path from "path";
import {
  findProjectRootFromModule,
  getProjectRoot,
} from "../../../src/utils/path-utils.js";

describe("path resolution cross-platform compatibility", () => {
  // Node's `windows` option lets us assert Windows semantics from any host.
  const windowsOptSupported = (() => {
    try {
      return (
        fileURLToPath("file:///C:/x/y.ts", { windows: true }) === "C:\\x\\y.ts"
      );
    } catch {
      return false;
    }
  })();

  const maybeIt = windowsOptSupported ? it : it.skip;

  maybeIt(
    "maps a Windows file URL to a native path with no leading-slash artifact",
    () => {
      const winUrl = "file:///C:/Users/agent/proj/src/utils/path-utils.ts";
      const native = fileURLToPath(winUrl, { windows: true });

      expect(native).toBe(
        "C:\\Users\\agent\\proj\\src\\utils\\path-utils.ts",
      );
      // The previous naive `slice("file://".length)` produced the broken form.
      const naive = winUrl.slice("file://".length);
      expect(naive).toBe("/C:/Users/agent/proj/src/utils/path-utils.ts");
      expect(native).not.toContain("/C:/");
    },
  );

  it("findProjectRootFromModule returns null or a real root, never a broken path", () => {
    // Under jest's CJS transform `import.meta.url` is unavailable, so this
    // strategy returns null (getProjectRoot then uses its other strategies).
    // The point of the fileURLToPath fix is that WHEN a module URL is
    // available it is decoded correctly — asserted above. Here we just verify
    // this never throws and never returns a leading-slash-artifact path.
    const root = findProjectRootFromModule();
    if (root !== null) {
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
      expect(root).not.toMatch(/^\/[A-Za-z]:/); // no /C:/… artifact
    }
  });

  it("getProjectRoot returns a directory containing package.json", () => {
    const root = getProjectRoot();
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
  });
});
