/**
 * Contract for execute-code: six black-box cases through the real
 * `execute_code` tool. Each spawns a real process; the whole run takes a
 * few seconds and touches no network. Any throw fails the contract.
 *
 * Imports nothing at runtime; the type-only import is erased.
 */

import type { ContractDeps } from "../../../../src/components/sdk.js";

const TOOL = "execute_code";

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function show(text: string): string {
  return JSON.stringify(text.length > 400 ? `${text.slice(0, 400)}…` : text);
}

export default async function (deps: ContractDeps): Promise<void> {
  const component = deps.component as { dispose?: (threadId?: string) => Promise<void> };
  try {
    await cases(deps);
  } finally {
    // Leave nothing behind, pass or fail: every workspace and bridge this
    // contract created goes.
    await component.dispose?.();
  }
}

async function cases(deps: ContractDeps): Promise<void> {
  const run = (code: string, extra: Record<string, unknown> = {}, threadId?: string) =>
    deps.invoke(TOOL, { code, ...extra }, threadId ? { threadId } : undefined);

  // 1. Arithmetic: the output is exactly what the program printed.
  const arithmetic = await run("console.log(6 * 7)");
  check(
    arithmetic.trim() === "42",
    `arithmetic: expected "42", got ${show(arithmetic)}`,
  );

  // 2. A multi-line program: a function, a loop and structured output.
  const program = await run(
    [
      "function square(n: number): number { return n * n; }",
      "const squares: number[] = [];",
      "for (let i = 1; i <= 4; i++) { squares.push(square(i)); }",
      "const total = squares.reduce((sum, n) => sum + n, 0);",
      "console.log(JSON.stringify({ squares, total }));",
    ].join("\n"),
  );
  check(
    program.trim() === '{"squares":[1,4,9,16],"total":30}',
    `program: unexpected output ${show(program)}`,
  );

  // 3. A runtime error comes back as text, not as a thrown error.
  const failure = await run('throw new Error("boom")');
  check(
    failure.startsWith("Execution failed (exit code 1)"),
    `runtime error: expected an "Execution failed (exit code 1)" result, got ${show(failure)}`,
  );
  check(failure.includes("boom"), `runtime error: message missing from ${show(failure)}`);

  // 4. Validation rejects an empty program before anything runs.
  const invalid = await run("   \n  ");
  check(
    invalid.startsWith("Invalid code:"),
    `validation: expected an "Invalid code:" result, got ${show(invalid)}`,
  );

  // 5. The timeout is honoured and named in the result.
  const started = Date.now();
  const timedOut = await run(
    "let n = 0; while (true) { n = (n + 1) % 7; }",
    { timeout: 1000 },
  );
  const elapsed = Date.now() - started;
  check(
    timedOut.startsWith("Execution timed out after 1000 ms"),
    `timeout: expected a timeout result, got ${show(timedOut)}`,
  );
  check(elapsed < 5000, `timeout: took ${elapsed} ms to return`);

  // 6. Two threads get two workspaces; a file written in one is absent in
  //    the other.
  const stamp = globalThis.crypto.randomUUID();
  const threadA = `contract-execute-code-a-${stamp}`;
  const threadB = `contract-execute-code-b-${stamp}`;
  const marker = "isolation-marker.txt";
  const locate = [
    'import { dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const here = dirname(fileURLToPath(import.meta.url));",
  ].join("\n");

  const fromA = await run(
    [
      locate,
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(here + "/${marker}", "written by thread A");`,
      "console.log(here);",
    ].join("\n"),
    {},
    threadA,
  );
  const dirA = fromA.trim();

  const fromB = await run(
    [
      locate,
      'import { existsSync } from "node:fs";',
      `console.log(JSON.stringify({ here, sawMarker: existsSync(here + "/${marker}") }));`,
    ].join("\n"),
    {},
    threadB,
  );
  let parsedB: { here?: unknown; sawMarker?: unknown };
  try {
    parsedB = JSON.parse(fromB.trim());
  } catch (_error) {
    throw new Error(`isolation: thread B printed ${show(fromB)}`);
  }
  const dirB = String(parsedB.here ?? "");

  check(dirA.length > 0 && dirA.includes(".code-workspace"), `isolation: thread A ran outside a workspace: ${show(dirA)}`);
  check(dirB.includes(".code-workspace"), `isolation: thread B ran outside a workspace: ${show(dirB)}`);
  check(dirA !== dirB, `isolation: both threads shared the workspace ${show(dirA)}`);
  check(parsedB.sawMarker === false, "isolation: thread B saw the file thread A wrote");
}
