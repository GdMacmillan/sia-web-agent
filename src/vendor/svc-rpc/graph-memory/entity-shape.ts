/**
 * Codec between the LLM-facing entity shape:
 *
 *   { entity_type, title, content, context?, tags?, priority?,
 *     status?, abstraction_level?, metadata?, related_entity_ids?,
 *     relationship_types? }
 *
 * and the graph-memory service's wire shape. Pure functions only —
 * no I/O.
 */
import type {
  EntitiesStoreRequest,
  EntitiesStoreResponse,
  EntitiesRetrieveResponse,
  EntitiesUpdateResponse,
} from "./ir-types.js";

/* ------------------------------------------------------------------------- */
/* LLM-facing entity shapes                                                  */
/* ------------------------------------------------------------------------- */

export type Priority = "low" | "medium" | "high";

/** Input shape accepted by the `store_entity` tool. */
export interface EntityStoreInput {
  entity_type: string;
  title: string;
  content: string;
  context?: string;
  tags?: string[];
  priority?: Priority;
  status?: string;
  abstraction_level?: "raw" | "synthesized" | "abstract";
  metadata?: Record<string, unknown>;
  related_entity_ids?: string[];
  relationship_types?: string[];
}

/** Entity shape returned to the LLM on read paths. */
export interface StoredEntityShape {
  id: string;
  entity_type: string;
  title: string;
  content: string;
  context?: string;
  tags: string[];
  priority: Priority;
  status: string;
  metadata: Record<string, unknown>;
  agent_id?: string;
  created_at: string;
  updated_at: string;
}

/**
 * The `user_input` wire field carries the encoded
 * `"[entity_type] title"` prefix the service uses as a storage
 * convention. This decoder is the inverse.
 */
export function parseUserInput(userInput: string | undefined): {
  entity_type?: string;
  title?: string;
} {
  if (!userInput) return {};
  if (userInput.startsWith("[")) {
    const idx = userInput.indexOf("] ");
    if (idx > 0) {
      return {
        entity_type: userInput.substring(1, idx) || undefined,
        title: userInput.substring(idx + 2).trim() || undefined,
      };
    }
  }
  return { title: userInput };
}

/**
 * Encode the LLM-friendly entity into the `entities.store` wire request
 * (the `Conversation` shape). `agentId` is the only piece of host
 * context the codec needs — passed in explicitly so the codec stays
 * pure.
 *
 * Note: relationship metadata is NOT stored on the node; edges are
 * created with a follow-up `graph.edges` call. The relationship arrays
 * remain on the input only so the caller can issue those follow-ups.
 */
export function encodeStoreRequest(
  input: EntityStoreInput,
  opts: { agentId: string; nowIso?: string },
): EntitiesStoreRequest {
  const timestamp = opts.nowIso ?? new Date().toISOString();
  return {
    agent_id: opts.agentId,
    user_input: `[${input.entity_type}] ${input.title}`,
    agent_output: input.content,
    context: input.context ?? input.entity_type,
    metadata: {
      entity_type: input.entity_type,
      title: input.title,
      content: input.content,
      context: input.context,
      tags: input.tags ?? [],
      priority: input.priority ?? "medium",
      status: input.status ?? "active",
      abstraction_level: input.abstraction_level ?? "raw",
      created_at: timestamp,
      updated_at: timestamp,
      custom_metadata: input.metadata ?? {},
    },
  };
}

/**
 * Decode a `Node`-shaped wire response into the LLM-friendly entity.
 * The graph stores heterogeneous property maps — try nested `metadata`
 * first, then fall back to flat properties and to the `user_input`
 * prefix.
 */
export function decodeNode(
  node: { id: string; properties?: Record<string, unknown> } | null | undefined,
): StoredEntityShape | null {
  if (!node) return null;
  const props = (node.properties ?? {}) as Record<string, unknown>;
  const metaSource = props.metadata;
  const metadata: Record<string, unknown> =
    metaSource && typeof metaSource === "object"
      ? (metaSource as Record<string, unknown>)
      : props;

  const parsed = parseUserInput(
    typeof props.user_input === "string" ? props.user_input : undefined,
  );

  const now = new Date().toISOString();
  return {
    id: node.id,
    entity_type:
      pickString(metadata.entity_type) ?? parsed.entity_type ?? "unknown",
    title:
      pickString(metadata.title) ??
      parsed.title ??
      pickString(props.title) ??
      "Untitled",
    content:
      pickString(props.agent_output) ?? pickString(metadata.content) ?? "",
    context: pickString(metadata.context) ?? pickString(props.context),
    tags: pickStringArray(metadata.tags) ?? [],
    priority: (pickString(metadata.priority) ?? "medium") as Priority,
    status: pickString(metadata.status) ?? "active",
    metadata:
      (metadata.custom_metadata && typeof metadata.custom_metadata === "object"
        ? (metadata.custom_metadata as Record<string, unknown>)
        : {}) ?? {},
    agent_id: pickString(props.agent_id),
    created_at: pickString(metadata.created_at) ?? now,
    updated_at: pickString(metadata.updated_at) ?? now,
  };
}

/**
 * Decode a `Conversation`-shaped wire response (returned by
 * `entities.store`) into the LLM-friendly entity. The conversation
 * envelope carries the same metadata bag inside `metadata`; we hand it
 * off to {@link decodeNode}-style mapping for consistency.
 */
export function decodeStoreResponse(
  resp: EntitiesStoreResponse,
  input: EntityStoreInput,
): StoredEntityShape {
  const meta = (resp.metadata ?? {}) as Record<string, unknown>;
  return {
    id: resp.id,
    entity_type: input.entity_type,
    title: input.title,
    content: input.content,
    context: input.context,
    tags: input.tags ?? [],
    priority: (input.priority ?? "medium") as Priority,
    status: input.status ?? "active",
    metadata: input.metadata ?? {},
    agent_id: resp.agent_id,
    created_at: pickString(meta.created_at) ?? resp.timestamp,
    updated_at: pickString(meta.updated_at) ?? resp.timestamp,
  };
}

/**
 * Decode a `entities.retrieve` wire response (a `Node | null`).
 * Returns null when the node is missing so the caller can format the
 * "not found" error in its own tool-specific shape.
 */
export function decodeRetrieveResponse(
  resp: EntitiesRetrieveResponse,
): StoredEntityShape | null {
  if (!resp) return null;
  return decodeNode(resp);
}

/**
 * Decode a `entities.update` / `entities.update_status` wire response
 * into the LLM-friendly entity plus the version + changed_fields
 * envelope. The wire shape stores fresh metadata under
 * `properties.metadata`.
 */
export function decodeUpdateResponse(
  resp: EntitiesUpdateResponse,
): StoredEntityShape & { version: number; changed_fields: string[] } {
  const decoded =
    decodeNode({ id: resp.id, properties: resp.properties }) ??
    fallbackEntityShape(resp.id);
  return {
    ...decoded,
    version: resp.version,
    changed_fields: resp.changed_fields,
  };
}

/* ------------------------------------------------------------------------- */
/* Update payload builders                                                   */
/* ------------------------------------------------------------------------- */

export interface EntityUpdateFields {
  title?: string;
  content?: string;
  tags?: string[];
  priority?: Priority;
  context?: string;
  status?: string;
}

export interface EntityUpdateModes {
  content?: "replace" | "append";
  tags?: "replace" | "merge";
}

/**
 * Build the `entities.update` properties + modes payload. Only fields
 * the caller explicitly sets are passed through; modes are tracked
 * alongside.
 */
export function buildUpdatePayload(
  updates: EntityUpdateFields,
  modes: EntityUpdateModes = {},
  notes?: string,
): {
  properties: { metadata: Record<string, unknown> };
  modes: Record<string, string>;
} {
  const metadataUpdates: Record<string, unknown> = {};
  const modeMap: Record<string, string> = {};

  if (updates.title !== undefined) metadataUpdates.title = updates.title;
  if (updates.content !== undefined) {
    metadataUpdates.content = updates.content;
    if (modes.content) modeMap.content = modes.content;
  }
  if (updates.tags !== undefined) {
    metadataUpdates.tags = updates.tags;
    if (modes.tags) modeMap.tags = modes.tags;
  }
  if (updates.priority !== undefined)
    metadataUpdates.priority = updates.priority;
  if (updates.context !== undefined) metadataUpdates.context = updates.context;
  if (updates.status !== undefined) metadataUpdates.status = updates.status;
  if (notes) metadataUpdates.update_notes = notes;

  return {
    properties: { metadata: metadataUpdates },
    modes: modeMap,
  };
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === "string")) return undefined;
  return value as string[];
}

function fallbackEntityShape(id: string): StoredEntityShape {
  const now = new Date().toISOString();
  return {
    id,
    entity_type: "unknown",
    title: "Untitled",
    content: "",
    tags: [],
    priority: "medium",
    status: "active",
    metadata: {},
    created_at: now,
    updated_at: now,
  };
}
