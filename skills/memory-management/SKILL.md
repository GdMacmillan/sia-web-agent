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

## Critical Rules

- **NEVER delegate memory operations to sub-agents.** Use memory tools directly for all knowledge management.
- **`search_entities` searches MEMORY only** — it does NOT search code files. Use `search` or `grep` for code.
- **Link new knowledge** to existing entities when relevant relationships exist.
