/**
 * Component lineage in graph memory — the I/O half. Thin wrappers over
 * the vendored graph-memory handlers so the component tools and the
 * reconciler share one way of finding, writing and settling
 * `component_version` entities.
 *
 * Everything here throws on failure; callers decide what a failure means
 * (the tools report it in their result text, the reconciler logs it).
 */

import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import type { EntityStoreInput, StoredEntityShape } from "../vendor/svc-rpc/graph-memory/entity-shape.js";
import {
  listEntities,
  retrieveEntity,
  searchEntities,
  storeEntity,
  updateEntity,
} from "../vendor/svc-rpc/graph-memory/tool-handlers.js";
import {
  LINEAGE_ENTITY_TYPE,
  SUPERSEDES,
  buildLineageEntity,
  buildParentEntity,
  lineageTitle,
  settlePayload,
  type LineageEntityInput,
  type Verdict,
} from "./lineage.js";
import type { ComponentManifest } from "./manifest.js";

/** How many entities an exact-title lookup reads before giving up. */
const LOOKUP_LIMIT = 25;

/**
 * Find the entity for `name@version` by its exact title. Search first
 * (cheap, ranked); when the ranked search returns nothing of the type —
 * a raw entity can be shadowed by a higher-level hit on the same words —
 * fall back to a recent listing filtered by type.
 */
export async function findLineageEntity(
  adapter: IGraphMemoryAdapter,
  title: string,
): Promise<StoredEntityShape | null> {
  const searched = await searchEntities(adapter, {
    query: title,
    entity_type: LINEAGE_ENTITY_TYPE,
    limit: LOOKUP_LIMIT,
  });
  const hit = searched.entities.find((e) => e.title === title);
  if (hit) {
    return hit;
  }
  const listed = await listEntities(adapter, {
    entity_type: LINEAGE_ENTITY_TYPE,
    limit: LOOKUP_LIMIT * 4,
  });
  return listed.entities.find((e) => e.title === title) ?? null;
}

export interface StoredLineage {
  id: string;
  title: string;
  /** Present when a `SUPERSEDES` edge was asked for but not created. */
  edgeError?: string;
}

/**
 * Store one version's entity, linking it to its parent when a parent id
 * is given. A failed edge does not fail the store — it is reported so
 * the caller can say so.
 */
export async function storeLineageEntity(
  adapter: IGraphMemoryAdapter,
  input: LineageEntityInput,
  opts: { agentId: string; parentId?: string },
): Promise<StoredLineage> {
  const entity: EntityStoreInput = buildLineageEntity(input);
  const result = await storeEntity(adapter, {
    ...entity,
    agent_id: opts.agentId,
    ...(opts.parentId
      ? { related_entity_ids: [opts.parentId], relationship_types: [SUPERSEDES] }
      : {}),
  });
  const failed = result.edge_errors?.[0];
  return {
    id: result.id,
    title: entity.title,
    ...(failed ? { edgeError: failed.error } : {}),
  };
}

/**
 * Make sure the parent version has an entity, creating one from its own
 * manifest when it does not. Returns the parent's entity id.
 */
export async function ensureParentEntity(
  adapter: IGraphMemoryAdapter,
  parent: ComponentManifest,
  opts: { agentId: string },
): Promise<{ id: string; created: boolean }> {
  const title = lineageTitle(parent.name, parent.version);
  const existing = await findLineageEntity(adapter, title);
  if (existing) {
    return { id: existing.id, created: false };
  }
  const stored = await storeEntity(adapter, {
    ...buildParentEntity(parent),
    agent_id: opts.agentId,
  });
  return { id: stored.id, created: true };
}

export type AnnounceResult = "stamped" | "already_settled";

/**
 * Merge fields into an entity's `provenance` (the structured copy of who
 * produced it and when it was announced), leaving the rest untouched.
 * Mirrors {@link settleLineageEntity}'s idempotency guard: a version whose
 * outcome is no longer `candidate` is left exactly as it is — settlement
 * can race an announcement, and a settled entity must not be re-stamped.
 */
export async function markLineageAnnounced(
  adapter: IGraphMemoryAdapter,
  entityId: string,
  announcedAt: string,
): Promise<AnnounceResult> {
  const { entity } = await retrieveEntity(adapter, { entity_id: entityId });
  if (entity.metadata.outcome !== "candidate") {
    return "already_settled";
  }
  const provenance =
    entity.metadata.provenance && typeof entity.metadata.provenance === "object"
      ? (entity.metadata.provenance as Record<string, unknown>)
      : {};
  await updateEntity(adapter, {
    entity_id: entityId,
    tags: entity.tags.includes("announced") ? undefined : ["announced"],
    tags_mode: "merge",
    metadata: { provenance: { ...provenance, announced_at: announcedAt } },
  });
  return "stamped";
}

export type SettleResult = "settled" | "already_settled";

/**
 * Settle an entity with a verdict. Idempotent: an entity that is no
 * longer a candidate is left exactly as it is, so a host push and a poll
 * that both carry the same verdict cannot disagree.
 */
export async function settleLineageEntity(
  adapter: IGraphMemoryAdapter,
  entityId: string,
  verdict: Verdict,
  now?: () => string,
): Promise<SettleResult> {
  const { entity } = await retrieveEntity(adapter, { entity_id: entityId });
  if (entity.metadata.outcome !== "candidate") {
    return "already_settled";
  }
  const payload = settlePayload(entity.tags, verdict, now);
  await updateEntity(adapter, {
    entity_id: entityId,
    content: payload.contentLine,
    content_mode: "append",
    tags: payload.tags,
    tags_mode: "replace",
    status: payload.status,
    metadata: payload.metadata,
    notes: `settled: ${verdict.outcome}`,
  });
  return "settled";
}
