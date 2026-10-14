/**
 * Content diff — what a skill or prompt version changes, as a unified diff
 * a person can read before deciding. Computed by the agent when it
 * announces a content version and carried to the host with the candidate,
 * so the keeper sees the actual change, not only its summary.
 *
 * Line-based Myers diff, three lines of context, one section per file.
 * Deterministic and dependency-free; never throws.
 */

import { readFileSync } from "node:fs";
import type { ContentSource } from "./content.js";

/** Lines of unchanged context around each change. */
export const DIFF_CONTEXT_LINES = 3;
/** Largest diff sent with a candidate, in bytes; longer ones are cut at a line. */
export const DIFF_MAX_BYTES = 32 * 1024;
/**
 * Inputs above this many lines in total are shown as a whole replacement
 * rather than diffed line by line (bounds the work; content versions are
 * far below it).
 */
const MAX_DIFF_LINES = 20_000;

type Op = { kind: " " | "-" | "+"; text: string };

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The shortest edit script from `a` to `b` (Myers, O((N+M)D)). */
function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n + m > MAX_DIFF_LINES) {
    return [
      ...a.map((text): Op => ({ kind: "-", text })),
      ...b.map((text): Op => ({ kind: "+", text })),
    ];
  }
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])
          ? v[k + 1 + offset]
          : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vd[k - 1 + offset] < vd[k + 1 + offset])
        ? k + 1
        : k - 1;
    const prevX = vd[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "+", text: b[y - 1] });
      } else {
        ops.push({ kind: "-", text: a[x - 1] });
      }
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface UnifiedDiff extends DiffStats {
  /** The diff text; empty when the two are identical. */
  text: string;
}

/**
 * A unified diff of two texts, `--- <oldLabel>` / `+++ <newLabel>` then
 * one `@@` hunk per group of changes with `context` lines around each.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  labels: { old: string; new: string },
  context: number = DIFF_CONTEXT_LINES,
): UnifiedDiff {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== " ") changes.push(i);
  });
  if (changes.length === 0) {
    return { text: "", added: 0, removed: 0 };
  }

  // Old/new line index (0-based) at the start of each op.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (op.kind !== "+") ai++;
    if (op.kind !== "-") bi++;
  }

  const out: string[] = [`--- ${labels.old}`, `+++ ${labels.new}`];
  let added = 0;
  let removed = 0;
  let c = 0;
  while (c < changes.length) {
    const start = Math.max(0, changes[c] - context);
    let last = changes[c];
    while (c + 1 < changes.length && changes[c + 1] - last <= 2 * context) {
      c++;
      last = changes[c];
    }
    c++;
    const end = Math.min(ops.length - 1, last + context);
    const body: string[] = [];
    let oldLen = 0;
    let newLen = 0;
    for (let i = start; i <= end; i++) {
      const op = ops[i];
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== "+") oldLen++;
      if (op.kind !== "-") newLen++;
      if (op.kind === "+") added++;
      if (op.kind === "-") removed++;
    }
    const oldStart = oldLen === 0 ? aAt[start] : aAt[start] + 1;
    const newStart = newLen === 0 ? bAt[start] : bAt[start] + 1;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...body);
  }
  return { text: `${out.join("\n")}\n`, added, removed };
}

export interface ContentDiff extends DiffStats {
  /** The whole diff, every file; empty when nothing changed. */
  text: string;
  /** How many files differ. */
  files: number;
}

function readOr(abs: string | undefined): string {
  if (abs === undefined) {
    return "";
  }
  try {
    return readFileSync(abs, "utf-8");
  } catch (_error) {
    return "";
  }
}

/**
 * What `child` changes relative to `parent`, file by file (sorted by
 * path; the manifest is never part of it). A null parent diffs against
 * nothing, so every line reads as added.
 */
export function diffContentSources(
  parent: ContentSource | null,
  child: ContentSource,
): ContentDiff {
  const before = new Map((parent?.files ?? []).map((f) => [f.rel, f.abs]));
  const after = new Map(child.files.map((f) => [f.rel, f.abs]));
  const rels = [...new Set([...before.keys(), ...after.keys()])].sort();
  const parentLabel =
    parent === null ? "(none)" : `${parent.name}@${parent.version}`;
  const childLabel = `${child.name}@${child.version}`;
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const rel of rels) {
    const diff = unifiedDiff(readOr(before.get(rel)), readOr(after.get(rel)), {
      old: before.has(rel) ? `a/${rel} (${parentLabel})` : "/dev/null",
      new: after.has(rel) ? `b/${rel} (${childLabel})` : "/dev/null",
    });
    if (diff.text === "") {
      continue;
    }
    parts.push(diff.text);
    added += diff.added;
    removed += diff.removed;
    files++;
  }
  return { text: parts.join(""), added, removed, files };
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes at a line boundary, ending
 * with a line saying how many lines were left out. Unchanged when it fits.
 */
export function capDiff(
  text: string,
  maxBytes: number = DIFF_MAX_BYTES,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, truncated: false };
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;
  const marker = (rest: number): string =>
    `… diff truncated: ${rest} more lines\n`;
  let kept = 0;
  let bytes = 0;
  // Reserve room for the marker at its longest.
  const budget = maxBytes - Buffer.byteLength(marker(total), "utf-8");
  while (kept < total) {
    const next = Buffer.byteLength(lines[kept], "utf-8") + 1;
    if (bytes + next > budget) {
      break;
    }
    bytes += next;
    kept++;
  }
  const head = kept > 0 ? `${lines.slice(0, kept).join("\n")}\n` : "";
  return { text: `${head}${marker(total - kept)}`, truncated: true };
}
