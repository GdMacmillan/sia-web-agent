/**
 * Settles `component_version` entities once the host has decided.
 *
 * A prepared version starts as a `candidate` in graph memory. The verdict
 * reaches the agent two ways, and both end here:
 *
 * - the host **pushes** it (`POST /components/outcome`, see
 *   `docs/HOST_CONTRACT.md`) → {@link LineageReconciler.onHostOutcome};
 * - the agent **polls** `GET /status` — at boot (a swap restarts the
 *   agent, so the verdict often lands while it is down) and, throttled,
 *   before a turn — and reads the verdict off the host's component store.
 *
 * Both paths settle through the same idempotent write, so they cannot
 * disagree. The reconciler never throws, never blocks boot, and latches
 * off for the process when graph memory is unreachable (the same rule the
 * memory-augmentation middleware follows).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { getMemoryAdapter } from "../tools/memory-adapter.js";
import { logger } from "../utils/logger.js";
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import { listComponentVersions } from "./authoring.js";
import { MANIFEST_FILE, VERSIONS_DIR } from "./discovery.js";
import { readHostComponents } from "./lineage-host.js";
import { findLineageEntity, settleLineageEntity } from "./lineage-store.js";
import {
  decideReconcile,
  isLineageOutcome,
  lineageTitle,
  type PendingVersion,
  type SettledOutcome,
  type Verdict,
} from "./lineage.js";

export interface TrackedVersion extends PendingVersion {
  entityId: string;
}

/** The host's outcome frame, as pushed to `POST /components/outcome`. */
export interface HostOutcomeFrame {
  kind: SettledOutcome;
  agentId: string;
  component: string;
  version: string;
  reason?: string;
  at?: string;
}

export type HostOutcomeResult =
  | { status: "settled" | "already_settled"; entityId: string }
  | { status: "not_found" }
  | { status: "ignored"; reason: "other_agent" | "invalid_frame" | "memory_unavailable" };

export interface LineageReconcilerOptions {
  agentId?: string;
  /** Host daemon base url; without one the poll is off and only the push settles. */
  daemonUrl?: string;
  /** Root the host manages; the boot pending set is read from it. */
  componentsDir?: string;
  getAdapter?: () => IGraphMemoryAdapter;
  fetchImpl?: typeof fetch;
  /** Versions on disk this agent produced; defaults to scanning `componentsDir`. */
  discoverLocalVersions?: () => Promise<PendingVersion[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  bootCapMs?: number;
  turnThrottleMs?: number;
  requestTimeoutMs?: number;
}

export interface LineageReconciler {
  /** Discover pending versions and poll the host for their verdicts. Never rejects. */
  onBoot(): Promise<void>;
  /** Throttled check before a turn; only while something is pending. Never rejects. */
  onTurn(): Promise<void>;
  /** A verdict pushed by the host. Rejects only on a graph-memory failure. */
  onHostOutcome(frame: unknown): Promise<HostOutcomeResult>;
  /** Remember a version just prepared so its verdict is watched for. */
  track(entityId: string, name: string, version: string): void;
  /** Stop watching a version (its entity was settled by other means). */
  untrack(name: string, version: string): void;
  pending(): TrackedVersion[];
  enabled(): boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_BOOT_CAP_MS = 120_000;
const DEFAULT_TURN_THROTTLE_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

const SETTLED_KINDS: readonly string[] = ["converged", "reverted", "failed", "rejected"];

function key(name: string, version: string): string {
  return lineageTitle(name, version);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every version under `<componentsDir>/<name>/.versions/` whose manifest
 * says this agent produced it. Reads the manifests leniently — a version
 * that fails to load is still a version whose verdict may be pending.
 */
export async function discoverProducedVersions(
  componentsDir: string | undefined,
  agentId: string,
): Promise<PendingVersion[]> {
  if (!componentsDir) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(componentsDir).filter((name) => {
      try {
        return statSync(path.join(componentsDir, name, VERSIONS_DIR)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const found: PendingVersion[] = [];
  for (const name of names) {
    const componentDir = path.join(componentsDir, name);
    for (const version of listComponentVersions(componentDir)) {
      try {
        const raw = readFileSync(path.join(componentDir, VERSIONS_DIR, version, MANIFEST_FILE), "utf8");
        const manifest = JSON.parse(raw) as { lineage?: { producedBy?: unknown } };
        if (manifest.lineage?.producedBy === agentId) {
          found.push({ name, version });
        }
      } catch {
        // Not this agent's, or not readable: nothing to reconcile.
      }
    }
  }
  return found;
}

function parseFrame(frame: unknown): HostOutcomeFrame | null {
  if (!frame || typeof frame !== "object") {
    return null;
  }
  const f = frame as Record<string, unknown>;
  if (
    typeof f.kind !== "string" ||
    !SETTLED_KINDS.includes(f.kind) ||
    typeof f.agentId !== "string" ||
    typeof f.component !== "string" ||
    f.component === "" ||
    typeof f.version !== "string" ||
    f.version === ""
  ) {
    return null;
  }
  return {
    kind: f.kind as SettledOutcome,
    agentId: f.agentId,
    component: f.component,
    version: f.version,
    ...(typeof f.reason === "string" && f.reason !== "" ? { reason: f.reason } : {}),
    ...(typeof f.at === "string" && f.at !== "" ? { at: f.at } : {}),
  };
}

export function createLineageReconciler(opts: LineageReconcilerOptions = {}): LineageReconciler {
  const runtime = (): { agentId: string; daemonUrl?: string; componentsDir?: string } => {
    try {
      const cfg = getConfig().runtime;
      return {
        agentId: opts.agentId ?? cfg.agentId,
        daemonUrl: Object.hasOwn(opts, "daemonUrl") ? opts.daemonUrl : process.env.SIA_DAEMON_URL,
        componentsDir: Object.hasOwn(opts, "componentsDir") ? opts.componentsDir : cfg.componentsDir,
      };
    } catch {
      return {
        agentId: opts.agentId ?? "",
        daemonUrl: opts.daemonUrl,
        componentsDir: opts.componentsDir,
      };
    }
  };
  const getAdapter = opts.getAdapter ?? getMemoryAdapter;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const bootCapMs = opts.bootCapMs ?? DEFAULT_BOOT_CAP_MS;
  const turnThrottleMs = opts.turnThrottleMs ?? DEFAULT_TURN_THROTTLE_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const pending = new Map<string, TrackedVersion>();
  let latchedOff = false;
  let adapter: IGraphMemoryAdapter | null = null;
  let lastTurnCheckAt: number | null = null;
  let pass: Promise<void> = Promise.resolve();

  const latch = (reason: string, error?: unknown): void => {
    latchedOff = true;
    logger.debug({ reason, error: error && errorMessage(error) }, "component lineage: disabled for this process");
  };

  const resolveAdapter = (): IGraphMemoryAdapter | null => {
    if (latchedOff) return null;
    if (adapter) return adapter;
    try {
      adapter = getAdapter();
      return adapter;
    } catch (error) {
      latch("graph memory unavailable", error);
      return null;
    }
  };

  const settle = async (
    a: IGraphMemoryAdapter,
    tracked: TrackedVersion,
    verdict: Verdict,
  ): Promise<"settled" | "already_settled"> => {
    const result = await settleLineageEntity(a, tracked.entityId, verdict, () =>
      new Date(now()).toISOString(),
    );
    pending.delete(key(tracked.name, tracked.version));
    logger.info(
      { component: tracked.name, version: tracked.version, outcome: verdict.outcome, result },
      "component lineage: settled",
    );
    return result;
  };

  /** One read of the host, one decision per pending version. */
  const reconcileOnce = async (phase: "boot" | "turn", capReached: boolean): Promise<void> => {
    const a = resolveAdapter();
    const { daemonUrl } = runtime();
    if (!a || !daemonUrl || pending.size === 0) {
      return;
    }
    const view = await readHostComponents(fetchImpl, daemonUrl, requestTimeoutMs);
    for (const tracked of [...pending.values()]) {
      const decision = decideReconcile(tracked, view, phase, capReached);
      if (decision.action !== "settle") {
        continue;
      }
      try {
        await settle(a, tracked, decision);
      } catch (error) {
        logger.warn(
          { component: tracked.name, version: tracked.version, error: errorMessage(error) },
          "component lineage: settle failed",
        );
      }
    }
  };

  /** Serialise passes so a turn check and the boot poll never interleave. */
  const runPass = (fn: () => Promise<void>): Promise<void> => {
    const next = pass.then(fn, fn);
    pass = next.catch(() => undefined);
    return next;
  };

  const discoverPending = async (): Promise<void> => {
    const a = resolveAdapter();
    if (!a) return;
    const { agentId, componentsDir } = runtime();
    const local = opts.discoverLocalVersions
      ? await opts.discoverLocalVersions()
      : await discoverProducedVersions(componentsDir, agentId);
    for (const version of local) {
      const k = key(version.name, version.version);
      if (pending.has(k)) continue;
      const entity = await findLineageEntity(a, k);
      if (entity && entity.metadata.outcome === "candidate") {
        pending.set(k, { ...version, entityId: entity.id });
      }
    }
  };

  const onBoot = async (): Promise<void> => {
    try {
      await discoverPending();
    } catch (error) {
      // First contact with graph memory failed: treat it as not here.
      latch("boot discovery failed", error);
      return;
    }
    if (pending.size === 0) {
      return;
    }
    if (!runtime().daemonUrl) {
      logger.debug("component lineage: no daemon url; waiting for the host to push verdicts");
      return;
    }
    logger.info({ pending: [...pending.keys()] }, "component lineage: polling the host for verdicts");
    const started = now();
    try {
      for (;;) {
        const capReached = now() - started >= bootCapMs;
        await runPass(() => reconcileOnce("boot", capReached));
        if (pending.size === 0 || capReached) {
          break;
        }
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "component lineage: boot poll stopped");
    }
  };

  const onTurn = async (): Promise<void> => {
    if (latchedOff || pending.size === 0) {
      return;
    }
    const t = now();
    if (lastTurnCheckAt !== null && t - lastTurnCheckAt < turnThrottleMs) {
      return;
    }
    lastTurnCheckAt = t;
    try {
      await runPass(() => reconcileOnce("turn", false));
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "component lineage: turn check failed");
    }
  };

  const onHostOutcome = async (raw: unknown): Promise<HostOutcomeResult> => {
    const frame = parseFrame(raw);
    if (!frame || !isLineageOutcome(frame.kind)) {
      return { status: "ignored", reason: "invalid_frame" };
    }
    if (frame.agentId !== runtime().agentId) {
      return { status: "ignored", reason: "other_agent" };
    }
    const a = resolveAdapter();
    if (!a) {
      return { status: "ignored", reason: "memory_unavailable" };
    }
    const k = key(frame.component, frame.version);
    let tracked = pending.get(k);
    if (!tracked) {
      const entity = await findLineageEntity(a, k);
      if (!entity) {
        return { status: "not_found" };
      }
      tracked = { name: frame.component, version: frame.version, entityId: entity.id };
    }
    const verdict: Verdict = {
      outcome: frame.kind,
      ...(frame.reason ? { reason: frame.reason } : {}),
      ...(frame.at ? { at: frame.at } : {}),
    };
    const status = await settle(a, tracked, verdict);
    return { status, entityId: tracked.entityId };
  };

  return {
    onBoot,
    onTurn,
    onHostOutcome,
    track: (entityId, name, version) => {
      pending.set(key(name, version), { name, version, entityId });
    },
    untrack: (name, version) => {
      pending.delete(key(name, version));
    },
    pending: () => [...pending.values()],
    enabled: () => !latchedOff,
  };
}

let singleton: LineageReconciler | null = null;

/** The process-wide reconciler the tools, the middleware and the graph module share. */
export function getLineageReconciler(): LineageReconciler {
  if (!singleton) {
    singleton = createLineageReconciler();
  }
  return singleton;
}

/** Test seam: replace or clear the shared reconciler. */
export function _setLineageReconcilerForTests(reconciler: LineageReconciler | null): void {
  singleton = reconciler;
}
