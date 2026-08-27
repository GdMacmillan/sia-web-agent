/**
 * Search augmentation: turn a search-type tool call (grep / glob /
 * bash / search) into a graph-memory lookup and render whatever comes
 * back as a short, labeled context block the caller can attach to the
 * tool's own result.
 *
 * Everything here is pure and adapter-injected. The three pieces:
 *
 *   - `extractSearchQuery` — pulls a free-text query out of a tool's
 *     input (the grep pattern, the literal stems of a glob, the pattern
 *     argument of an `rg`/`grep`/`find` shell command).
 *   - `augmentSearch` — runs `searchEntities` against that query inside
 *     a hard time budget. It never throws and never rejects: any error
 *     or timeout yields an empty context, because a memory lookup must
 *     never be able to break the tool it decorates.
 *   - `formatSearchAugmentation` — renders the hits as labeled lines
 *     ending in the same `Next:` hint the search tool itself returns.
 *
 * Callers wrap this in their own surface-specific plumbing (which tool
 * results to decorate, how to obtain the adapter, where to cache).
 */
import type { IGraphMemoryAdapter } from "./adapter-interface.js";
import type { StoredEntityShape } from "./entity-shape.js";
import { nextStepForSearch, searchEntities } from "./tool-handlers.js";

/* ------------------------------------------------------------------------- */
/* Query extraction                                                          */
/* ------------------------------------------------------------------------- */

/** Tool names (case-insensitive) whose input carries a search pattern. */
export const SEARCH_AUGMENTATION_TOOL_NAMES: readonly string[] = [
  "grep",
  "glob",
  "search",
  "bash",
];

/** Shell commands whose first non-flag argument is a search pattern. */
const PATTERN_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);

/** Flags of those commands that consume the following token as a value. */
const VALUE_FLAGS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "--max-depth",
  "-j",
  "--threads",
  "--include",
  "--exclude",
  "--color",
]);

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_WORDS = 8;

export function isSearchAugmentationTool(toolName: string): boolean {
  return SEARCH_AUGMENTATION_TOOL_NAMES.includes(toolName.toLowerCase());
}

/**
 * Extract a free-text query from a search-type tool call. Returns
 * `null` when the tool is not a search tool, when the input has no
 * usable pattern, or when the pattern is too short / too generic to be
 * worth a lookup (`*`, `..`, single characters).
 */
export function extractSearchQuery(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;

  switch (toolName.toLowerCase()) {
    case "grep":
    case "search":
      return normalizeQuery(stripRegex(readString(input.pattern)));
    case "glob":
      return normalizeQuery(globStems(readString(input.pattern)));
    case "bash":
      return normalizeQuery(
        stripRegex(patternFromCommand(readString(input.command))),
      );
    default:
      return null;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Replace regex syntax with whitespace so only literal terms remain. */
function stripRegex(pattern: string): string {
  return (
    pattern
      // Escape sequences (`\b`, `\s`, `\.`): drop the backslash and,
      // for class shorthands, the letter too.
      .replace(/\\[bBdDsSwW]/g, " ")
      .replace(/\\(.)/g, "$1")
      // Everything that is regex syntax rather than a literal.
      .replace(/[.^$|?*+()[\]{}]/g, " ")
  );
}

/** Reduce a glob to its literal path stems (`src/**\/auth*.ts` → `src auth`). */
function globStems(pattern: string): string {
  const stems: string[] = [];
  for (const rawSegment of pattern.split(/[\\/]+/)) {
    const segment = rawSegment.replace(/[*?[\]{},!]/g, " ").trim();
    if (!segment) continue;
    const pieces = segment
      .split(/[\s.]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (pieces.length === 0) continue;
    // A trailing short piece after a dot is almost always a file
    // extension — not something anyone stored a memory about. A
    // segment that *starts* with a dot (`*.go` → `.go`) is extension-only.
    const lastPiece = pieces[pieces.length - 1]!;
    if (
      segment.includes(".") &&
      lastPiece.length <= 4 &&
      (pieces.length > 1 || segment.startsWith("."))
    ) {
      pieces.pop();
    }
    stems.push(...pieces);
  }
  return stems.join(" ");
}

/**
 * Find the pattern argument of the first `rg`/`grep`/`ag`/`find`
 * invocation in a shell command. Pipelines and chains are scanned
 * left to right; the first match wins.
 */
function patternFromCommand(command: string): string {
  if (!command.trim()) return "";
  for (const segment of command.split(/\|\|?|&&|;|\n/)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    // Skip leading env assignments / sudo / time.
    let i = 0;
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) ||
        tokens[i] === "sudo" ||
        tokens[i] === "time" ||
        tokens[i] === "env")
    ) {
      i++;
    }
    const cmd = basename(tokens[i] ?? "");
    if (cmd === "find") {
      const found = findNameArgument(tokens.slice(i + 1));
      if (found) return found;
      continue;
    }
    if (!PATTERN_COMMANDS.has(cmd)) continue;
    const found = firstPositional(tokens.slice(i + 1));
    if (found) return found;
  }
  return "";
}

function findNameArgument(args: string[]): string {
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i];
    if (
      flag === "-name" ||
      flag === "-iname" ||
      flag === "-path" ||
      flag === "-ipath" ||
      flag === "-regex" ||
      flag === "-iregex"
    ) {
      return globStems(args[i + 1]!);
    }
  }
  return "";
}

function firstPositional(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") {
      return args[i + 1] ?? "";
    }
    if (token.startsWith("-")) {
      // `-e PATTERN` / `--regexp PATTERN` is the pattern itself.
      if (token === "-e" || token === "--regexp") {
        return args[i + 1] ?? "";
      }
      if (token.startsWith("--regexp=")) return token.slice("--regexp=".length);
      if (VALUE_FLAGS.has(token)) i++; // consume the flag's value
      continue;
    }
    return token;
  }
  return "";
}

function basename(token: string): string {
  const idx = token.lastIndexOf("/");
  return idx >= 0 ? token.slice(idx + 1) : token;
}

/** Minimal shell tokenizer: honours single/double quotes and `\` escapes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Collapse whitespace, cap length, and reject queries too thin to search. */
function normalizeQuery(raw: string): string | null {
  const words = raw
    .replace(/[^\p{L}\p{N}_\-\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((w) => w.length > 0);
  const query = words.slice(0, MAX_QUERY_WORDS).join(" ");
  if (query.replace(/[\s_-]/g, "").length < MIN_QUERY_LENGTH) return null;
  return query;
}

/* ------------------------------------------------------------------------- */
/* Formatting                                                                */
/* ------------------------------------------------------------------------- */

export interface FormatSearchAugmentationOptions {
  /** Maximum number of entities to render. Default 3. */
  maxItems?: number;
  /** Maximum characters of an entity title to keep. Default 120. */
  maxTitleLength?: number;
}

/**
 * Render search hits as a labeled block. Returns `""` when there is
 * nothing to show so callers can test for emptiness directly.
 */
export function formatSearchAugmentation(
  query: string,
  entities: readonly StoredEntityShape[],
  options: FormatSearchAugmentationOptions = {},
): string {
  if (entities.length === 0) return "";
  const maxItems = options.maxItems ?? 3;
  const maxTitleLength = options.maxTitleLength ?? 120;
  const shown = entities.slice(0, maxItems);

  const noun = entities.length === 1 ? "entry" : "entries";
  const suffix =
    entities.length > shown.length ? ` (showing ${shown.length})` : "";
  const lines = [
    `Graph memory: ${entities.length} ${noun} related to "${query}"${suffix}`,
  ];
  for (const entity of shown) {
    const title = truncate(entity.title || "(untitled)", maxTitleLength);
    const meta = [`id: ${entity.id}`];
    if (entity.context) meta.push(`ctx: ${entity.context}`);
    lines.push(`- [${entity.entity_type}] ${title} (${meta.join(", ")})`);
  }
  lines.push(nextStepForSearch(entities.length));
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------------- */
/* Budgeted lookup                                                           */
/* ------------------------------------------------------------------------- */

export interface AugmentSearchResult {
  /** The query that was searched, or `null` when nothing was extracted. */
  query: string | null;
  entities: StoredEntityShape[];
  /** Rendered context block, `""` when there is nothing to attach. */
  context: string;
  count: number;
  cached: boolean;
  timedOut: boolean;
  /** Set when the lookup failed; the result is still a valid empty one. */
  error?: string;
  elapsedMs: number;
}

/** Minimal cache contract so callers can plug in their own store. */
export interface SearchAugmentationCache {
  get(key: string): AugmentSearchResult | undefined;
  set(key: string, value: AugmentSearchResult): void;
}

export interface AugmentSearchOptions {
  toolName: string;
  toolInput: unknown;
  /** Hard ceiling on the lookup. Default 500 ms. */
  budgetMs?: number;
  /** Passed through to `searchEntities`. Default 5. */
  limit?: number;
  /** Passed through to `searchEntities`. Default 0.3. */
  threshold?: number;
  /** Rendering options for the context block. */
  format?: FormatSearchAugmentationOptions;
  cache?: SearchAugmentationCache;
}

const EMPTY: Omit<AugmentSearchResult, "query" | "elapsedMs"> = {
  entities: [],
  context: "",
  count: 0,
  cached: false,
  timedOut: false,
};

/**
 * Look up graph-memory entities related to a search-type tool call.
 * Resolves within `budgetMs` (plus scheduling slack) no matter what the
 * adapter does; never rejects.
 */
export async function augmentSearch(
  adapter: IGraphMemoryAdapter,
  options: AugmentSearchOptions,
): Promise<AugmentSearchResult> {
  const started = Date.now();
  const query = extractSearchQuery(options.toolName, options.toolInput);
  if (!query) {
    return { ...EMPTY, query: null, elapsedMs: Date.now() - started };
  }

  const cacheKey = query.toLowerCase();
  const hit = options.cache?.get(cacheKey);
  if (hit) {
    return { ...hit, cached: true, elapsedMs: Date.now() - started };
  }

  const budgetMs = options.budgetMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });

  const lookup = searchEntities(adapter, {
    query,
    limit: options.limit ?? 5,
    threshold: options.threshold ?? 0.3,
  });
  // A late rejection after the timeout won fires as unhandled otherwise.
  lookup.catch(() => undefined);

  let result: AugmentSearchResult;
  try {
    const outcome = await Promise.race([lookup, timeout]);
    if (outcome === "timeout") {
      result = {
        ...EMPTY,
        query,
        timedOut: true,
        elapsedMs: Date.now() - started,
      };
    } else {
      const entities = outcome.entities;
      result = {
        query,
        entities,
        context: formatSearchAugmentation(query, entities, options.format),
        count: entities.length,
        cached: false,
        timedOut: false,
        elapsedMs: Date.now() - started,
      };
      options.cache?.set(cacheKey, result);
    }
  } catch (err) {
    result = {
      ...EMPTY,
      query,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return result;
}

/* ------------------------------------------------------------------------- */
/* TTL cache                                                                 */
/* ------------------------------------------------------------------------- */

export interface TtlCacheOptions {
  /** Entry lifetime. Default 120 000 ms. */
  ttlMs?: number;
  /** Maximum entries; the oldest is evicted first. Default 200. */
  maxEntries?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Small insertion-ordered TTL cache satisfying `SearchAugmentationCache`.
 * Repeated searches for the same term within a session cost nothing.
 */
export function createSearchAugmentationCache(
  options: TtlCacheOptions = {},
): SearchAugmentationCache & { size: () => number; clear: () => void } {
  const ttlMs = options.ttlMs ?? 120_000;
  const maxEntries = options.maxEntries ?? 200;
  const now = options.now ?? Date.now;
  const store = new Map<string, { value: AugmentSearchResult; at: number }>();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.delete(key);
      store.set(key, { value, at: now() });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    size: () => store.size,
    clear: () => store.clear(),
  };
}
