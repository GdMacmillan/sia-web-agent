---
name: memory-management
description: Memory tools reference covering entity types, relationship types, search strategies, and knowledge management best practices.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Memory and Knowledge Management

Detailed reference for graph memory tools, entity types, and relationship linking.

## When to Apply

- Searching for past learnings before starting work
- Storing discoveries, patterns, or decisions after completing work
- Linking related knowledge entities
- Understanding what memory tools are available and how to use them

## Available Memory Tools

| Tool                   | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `store_entity`         | Store any entity type with optional relationship edges                      |
| `search_entities`      | Semantic search for stored knowledge (NOT for code — use `search`/`grep`)   |
| `list_entities`        | Browse/filter stored knowledge by type, status, priority, tags              |
| `retrieve_entity`      | Get full entity details by ID                                               |
| `update_entity_status` | Update lifecycle status (active, completed, archived, in-progress, blocked) |
| `update_entity`        | Change fields, merge metadata, and add relationship edges                   |
| `promote_entities`     | Consolidate 3+ entities into one at the next abstraction level              |
| `traverse_graph`       | Follow relationship edges outward from one entity                           |

## Entity Types

Choose the appropriate type based on what you're storing:

| Type       | When to Use                                                   |
| ---------- | ------------------------------------------------------------- |
| `learning` | Knowledge from debugging, discoveries, understanding behavior |
| `pattern`  | Recurring approaches, conventions, or anti-patterns           |
| `decision` | Architectural choices with documented rationale               |
| `idea`     | Proposed improvements or future work                          |
| `note`     | General observations, quirks, or context                      |
| `task`     | Work items requiring action                                   |

## Abstraction Levels

Every entity has an `abstraction_level`:

- `raw` (default) — one observation from one piece of work.
- `synthesized` — a pattern consolidated from several raw entities.
- `abstract` — a high-level insight consolidated from several synthesized entities.

Store new findings as `raw`. When three or more raw entities describe the same thing, consolidate
them with `promote_entities(source_entity_ids=[...], target_level="synthesized")`; do the same with three
or more synthesized entities to reach `abstract`. Content is generated from the sources unless you
pass `title`/`content`, `dry_run=true` previews without writing, and the promoted entity stays
linked to its sources in both directions.

## Relationship Types

When storing entities, link them to related entities using these types:

| Type          | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| `IMPLEMENTS`  | Entity implements another (e.g., learning → idea)            |
| `DEPENDS_ON`  | Entity requires another to work                              |
| `SUPERSEDES`  | Entity replaces or obsoletes another                         |
| `CAUSED_BY`   | Entity resulted from another (e.g., fix → bug)               |
| `EXTENDS`     | Entity builds upon another                                   |
| `ESTABLISHES` | Entity creates or defines another (e.g., decision → pattern) |
| `VALIDATES`   | Entity proves or confirms another                            |
| `SIMILAR_TO`  | Entities address similar problems                            |
| `RELATED_TO`  | General relationship (default)                               |

## Usage Examples

### Searching before work

```
search_entities(query="authentication patterns", entity_type="pattern")
```

### Storing after work

```
store_entity(
  entity_type="learning",
  title="Redis cache invalidation fix",
  content="Cache keys weren't properly namespaced causing cross-tenant data leakage. Fixed by prefixing all keys with tenant_id.",
  context="caching",
  tags=["bug-fix", "redis", "multi-tenancy"],
  priority="high",
  related_entity_ids=["existing_entity_id"],
  relationship_types=["CAUSED_BY"]
)
```

## Searching Well

`search_entities` combines semantic and keyword matching across every entity type.

- Filters (`entity_type`, `tags`, `priority`, `status`) narrow the results; `limit` defaults to 10.
- HyDE (`use_hyde`, embedding a hypothetical answer) and query decomposition (`decompose`,
  splitting a multi-part question) switch on automatically when they help; set them only to force
  one on or off.
- Weighted re-ranking (`rerank`) is on by default; `rerank_preset` picks the weighting (`balanced` by
  default) and `include_scores=true` shows the breakdown.
- `list_entities` is for browsing rather than searching: it pages with `limit` (default 100) and
  `offset`.

## Updating and Linking

- Use `update_entity_status` for a status-only change and `update_entity` for anything else.
- `update_entity` replaces fields by default; `content_mode="append"` adds to the existing content
  and `tags_mode="merge"` unions the tags. `metadata` keys are merged into the existing metadata.
- `related_entity_ids` with a parallel `relationship_types` list adds edges from this entity to
  each target (default type `RELATED_TO`). The last few versions are kept, so explain the change
  in `notes`.
- `traverse_graph(node_id=..., direction="out" | "in" | "both", edge_types=[...], max_depth=1)`
  walks the edges; raise `max_depth` to follow chains of related entities.

## Critical Rules

- **NEVER delegate memory operations to sub-agents.** Use memory tools directly for all knowledge management.
- **`search_entities` searches MEMORY only** — it does NOT search code files. Use `search` or `grep` for code.
- **Link new knowledge** to existing entities when relevant relationships exist.
