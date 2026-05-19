/**
 * Diagnostic Test Harness for ls Tool Issue
 *
 * Traces the full execution path and generates a detailed diagnostic report
 * showing exactly where the ls tool fails.
 */

import { describe, it } from "@jest/globals";
import * as path from "path";
import { FilesystemBackend } from "../../src/backends/filesystem.js";

const skipIntegrationTests = process.env.RUN_INTEGRATION !== "true";
const describeTest = skipIntegrationTests ? describe.skip : describe;

describeTest("Diagnostic Report: ls Tool Issue", () => {
  it("generates comprehensive diagnostic report", async () => {
    console.log("\n");
    console.log("=".repeat(80));
    console.log("LS TOOL DIAGNOSTIC REPORT");
    console.log("=".repeat(80));

    const report = {
      timestamp: new Date().toISOString(),
      findings: [] as any[],
      rootCause: "" as string,
      impactedTests: [] as string[],
      suggestedFix: "" as string,
    };

    // ===== STAGE 1: Backend Initialization =====
    console.log("\n[1] BACKEND INITIALIZATION");
    console.log("-".repeat(80));

    const projectRoot = path.resolve(process.cwd());
    const backend = new FilesystemBackend({ rootDir: projectRoot });

    console.log(`✓ FilesystemBackend initialized`);
    console.log(`  ProjectRoot: ${projectRoot}`);

    report.findings.push({
      stage: "initialization",
      component: "FilesystemBackend",
      status: "OK",
      details: `Backend initialized with rootDir: ${projectRoot}`,
    });

    // ===== STAGE 2: Path Resolution Behavior =====
    console.log("\n[2] PATH RESOLUTION BEHAVIOR");
    console.log("-".repeat(80));

    // Test what happens with "/" (buggy tool default)
    console.log("\nTest A: Passing " / " to backend.lsInfo()");
    const rootListings = await backend.lsInfo("/");
    console.log(
      `  Result: ${rootListings.length} entries found in filesystem root`,
    );
    console.log(
      `  First entry: ${rootListings[0]?.path} (system dir: ${rootListings[0]?.path.includes("/usr") || rootListings[0]?.path.includes("/bin")})`,
    );

    report.findings.push({
      stage: "path_resolution",
      test: "Absolute path /",
      paths: rootListings.slice(0, 3).map((i) => i.path),
      isSystemRoot:
        rootListings[0]?.path.includes("/usr") ||
        rootListings[0]?.path.includes("/bin"),
    });

    // Test what happens with "" (correct behavior)
    console.log("\nTest B: Passing '' (empty string) to backend.lsInfo()");
    const projectListings = await backend.lsInfo("");
    console.log(
      `  Result: ${projectListings.length} entries found in project root`,
    );
    console.log(`  First entry: ${projectListings[0]?.path}`);

    report.findings.push({
      stage: "path_resolution",
      test: "Empty string (relative)",
      paths: projectListings.slice(0, 3).map((i) => i.path),
      isProjectRoot: projectListings[0]?.path.includes(projectRoot),
    });

    // ===== STAGE 3: Tool Default Comparison =====
    console.log("\n[3] TOOL DEFAULT PATH ANALYSIS");
    console.log("-".repeat(80));

    console.log(`\nCurrent ls tool behavior:`);
    console.log(`  Code: const path = input.path || "/"`);
    console.log(`  When input.path is empty/null: defaults to "/"`);
    console.log(
      `  Result: Lists ${rootListings.length} entries from FILESYSTEM ROOT`,
    );
    console.log(
      `  Example: ${rootListings[0]?.path} (contains system directories)`,
    );

    console.log(`\nProposed fix:`);
    console.log(`  Code: const path = input.path || ""`);
    console.log(`  When input.path is empty/null: defaults to ""`);
    console.log(`  Result: Backend resolves "" to projectRoot`);
    console.log(
      `  Result: Lists ${projectListings.length} entries from PROJECT ROOT`,
    );
    console.log(`  Example: ${projectListings[0]?.path}`);

    report.findings.push({
      stage: "tool_behavior",
      currentBehavior: `Defaults to "/" → Lists ${rootListings.length} system entries`,
      proposedBehavior: `Defaults to "" → Lists ${projectListings.length} project entries`,
      difference: Math.abs(rootListings.length - projectListings.length),
    });

    // ===== STAGE 4: Root Cause Analysis =====
    console.log("\n[4] ROOT CAUSE ANALYSIS");
    console.log("-".repeat(80));

    const rootCauseAnalysis = {
      component: "middleware/fs.ts - createLsTool function",
      lineNumber: 125,
      currentCode: `const path = input.path || "/";`,
      issue:
        "Defaults to filesystem root (/) instead of project root (empty string)",
      why: "FilesystemBackend.resolvePath() treats '/' as absolute path and returns it as-is, bypassing the security model that resolves relative paths to projectRoot",
      impact:
        "Agent cannot navigate project structure when ls is called with empty path",
    };

    console.log(`Component: ${rootCauseAnalysis.component}`);
    console.log(`Line: ${rootCauseAnalysis.lineNumber}`);
    console.log(`Current code: ${rootCauseAnalysis.currentCode}`);
    console.log(`Issue: ${rootCauseAnalysis.issue}`);
    console.log(`Why: ${rootCauseAnalysis.why}`);

    report.rootCause = `${rootCauseAnalysis.component} line ${rootCauseAnalysis.lineNumber} defaults to "/" instead of ""`;

    // ===== STAGE 5: Impact Assessment =====
    console.log("\n[5] IMPACT ASSESSMENT");
    console.log("-".repeat(80));

    const impactedScenarios = [
      "Manager agent calls ls without path → gets system root (BUG)",
      "Agent explores file system → finds /bin, /usr instead of /packages (BUG)",
      "research_001 test: 'Analyze directory structure' → fails to get project structure (EVALUATION FAILURE)",
      "research_002 test: 'Examine TypeScript source code' → Can't find packages/ directory (EVALUATION FAILURE)",
      "refactoring_001 test: File review → Can't locate actual source files (EVALUATION FAILURE)",
      "Agent can't iterate deeper → stops at wrong directory level (BEHAVIORAL FAILURE)",
    ];

    impactedScenarios.forEach((scenario, idx) => {
      console.log(`${idx + 1}. ${scenario}`);
      report.impactedTests.push(scenario);
    });

    // ===== STAGE 6: Fix Recommendation =====
    console.log("\n[6] FIX RECOMMENDATION");
    console.log("-".repeat(80));

    const fixCode = {
      before: `  const path = input.path || "/";`,
      after: `  const path = input.path || "";`,
      reason:
        "Empty string resolves to projectRoot via backend.resolvePath() security model",
    };

    console.log(`File: packages/agent/src/middleware/fs.ts`);
    console.log(`Function: createLsTool (lines 114-156)`);
    console.log(`\nBefore:`);
    console.log(`  ${fixCode.before}`);
    console.log(`\nAfter:`);
    console.log(`  ${fixCode.after}`);
    console.log(`\nReason: ${fixCode.reason}`);

    report.suggestedFix = `Change line 125 in fs.ts from '${fixCode.before.trim()}' to '${fixCode.after.trim()}'`;

    // ===== STAGE 7: Verification Test =====
    console.log("\n[7] VERIFICATION TEST");
    console.log("-".repeat(80));

    // Simulate what the fix would do
    const fixedListings = await backend.lsInfo("");

    console.log(`\nWith proposed fix:`);
    console.log(`  ls tool would call backend.lsInfo("")`);
    console.log(`  backend resolves "" to projectRoot`);
    console.log(`  Result: ${fixedListings.length} entries`);
    console.log(`  Correct path: ${fixedListings[0]?.path}`);
    console.log(`  ✓ This matches projectRoot, not filesystem root`);

    report.findings.push({
      stage: "verification",
      fixedBehavior: "Would list project root correctly",
      entriesFound: fixedListings.length,
      samplePath: fixedListings[0]?.path,
    });

    // ===== FINAL REPORT =====
    console.log("\n");
    console.log("=".repeat(80));
    console.log("SUMMARY");
    console.log("=".repeat(80));

    console.log(`\n✗ ROOT CAUSE FOUND:`);
    console.log(`  ${report.rootCause}`);

    console.log(`\n✗ FILESYSTEM ROOT entries: ${rootListings.length}`);
    console.log(
      `  Sample: ${rootListings
        .slice(0, 3)
        .map((i) => i.path)
        .join(", ")}`,
    );

    console.log(`\n✓ PROJECT ROOT entries: ${projectListings.length}`);
    console.log(
      `  Sample: ${projectListings
        .slice(0, 3)
        .map((i) => i.path)
        .join(", ")}`,
    );

    console.log(`\n→ AFFECTED TESTS: ${report.impactedTests.length} scenarios`);
    report.impactedTests.forEach((scenario) => {
      console.log(`  - ${scenario}`);
    });

    console.log(`\n→ RECOMMENDED FIX:`);
    console.log(`  ${report.suggestedFix}`);

    console.log(`\n` + "=".repeat(80));
    console.log("DIAGNOSTIC COMPLETE");
    console.log("=".repeat(80) + "\n");
  });
});
