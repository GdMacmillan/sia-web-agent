---
name: codebase-navigation
description: |
  REQUIRED for any task involving the codebase. Provides systematic exploration
  strategies for discovering architecture, finding implementations, tracing
  dependencies, and locating functionality using filesystem and search tools.
  You MUST load this skill before reading, searching, modifying, or analyzing
  any part of the codebase. Only skip for pure conversational or memory-only
  interactions.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Codebase Navigation

Systematic strategies for discovering context directly from source code, documentation, and memory
rather than relying on static summaries. The codebase is your source of truth — explore it.

## When to Apply

You MUST load this skill when your task involves ANY of:

- Reading, searching, or modifying source code
- Understanding architecture or design patterns
- Tracing imports, dependencies, or data flow
- Locating specific functionality or configuration
- Planning implementation changes
- Investigating bugs or unexpected behavior

Only skip for purely conversational tasks or memory-only operations.

## Discovery Tools

| Tool              | Purpose                            | Example                                      |
| ----------------- | ---------------------------------- | -------------------------------------------- |
| `ls`              | See directory structure            | `ls packages/agent/src/middleware`           |
| `glob`            | Find files by pattern              | `glob "**/*.test.ts"` or `glob "docs/*.md"`  |
| `grep`            | Search file contents by regex      | `grep "createMiddleware" --type=ts`          |
| `search`          | Ripgrep-based code search          | `search "TODO\|FIXME" --type=ts`             |
| `read_file`       | Read file contents with pagination | `read_file "src/agent.ts" offset=0 limit=50` |
| `bash`            | Shell commands for complex queries | `bash "wc -l packages/agent/src/**/*.ts"`    |
| `search_entities` | Semantic search over graph memory  | `search_entities "middleware architecture"`  |

## Exploration Strategies

### 1. Top-Down (Start Broad, Drill Down)

Best for: Understanding overall structure, onboarding to unfamiliar areas.

```
ls .                          → See project root layout
ls packages/                  → Identify packages
read_file "package.json"      → Understand workspaces and scripts
ls packages/agent/src/        → See agent source structure
ls docs/                      → Find architecture documentation
```

### 2. Pattern Search (Find by Name or Content)

Best for: Locating specific functions, types, configurations, or patterns.

```
grep "export function createMiddleware"   → Find function definitions
search "recursionLimit" --type=ts         → Find configuration values
glob "**/middleware/*.ts"                  → Find all middleware files
grep "import.*from.*subagents"            → Trace import relationships
```

### 3. Dependency Tracing (Follow the Thread)

Best for: Understanding how components connect, tracing data flow.

1. Find the entry point: `grep "export.*graph" packages/agent/src/graph.ts`
2. Read imports: `read_file "packages/agent/src/graph.ts" limit=30`
3. Follow each import to understand the dependency chain
4. Map relationships: which modules depend on which

### 4. Document Discovery (Find Written Knowledge)

Best for: Understanding design decisions, API contracts, testing strategy.

```
glob "docs/*.md"              → Find all architecture docs
glob "**/README.md"           → Find package-level docs
glob "**/*.md" --exclude="node_modules"  → All markdown in the project
read_file "docs/ARCHITECTURE.md"         → Read system design
```

### 5. Memory-Augmented Search (Recall Past Work)

Best for: Tasks related to previous work, recurring patterns, known issues.

```
search_entities "middleware refactoring"  → Find past learnings
search_entities "graph memory API"        → Recall architectural decisions
traverse_graph <entity_id> direction=out  → Explore related knowledge
```

**Always search memory before deep-diving into code** — past learnings may save significant
exploration time and prevent repeating known mistakes.

## Project Layout Reference

These are discovery starting points, not exhaustive documentation. Always verify against
the actual filesystem — the codebase may have changed.

```
.
├── packages/
│   ├── agent/          → Core agent (entry: src/graph.ts)
│   │   ├── src/
│   │   │   ├── middleware/   → Tool implementations
│   │   │   ├── tools/        → Tool definitions
│   │   │   ├── config/       → LLM provider configuration
│   │   │   └── utils/        → Shared utilities
│   │   ├── prompts/          → Agent system prompts (*.md)
│   │   └── tests/            → Unit and integration tests
│   ├── web/            → Next.js frontend
│   └── graph-memory/   → Go API server for graph memory
├── docs/               → Architecture and design docs
├── skills/             → Agent skill library (SKILL.md files)
└── mcp/                → MCP server integrations
```

## Best Practices

- **Start with memory**: `search_entities` before code exploration to leverage past learnings
- **Verify, don't assume**: File paths and function names in documentation may be stale — always
  check the filesystem to confirm they still exist
- **Read imports first**: The import block at the top of a file reveals its dependencies and
  the types/functions it uses
- **Use parallel searches**: When looking for multiple independent things, make parallel tool calls
- **Scope your search**: Use `--type=ts` or glob patterns to narrow results rather than searching
  everything
- **Follow the entry point**: `packages/agent/src/graph.ts` is the main agent entry point; start
  there when tracing execution flow

## Anti-Patterns

- Relying on cached or static documentation without verifying against code
- Reading entire files when you only need specific functions — use `offset`/`limit`
- Searching too broadly — scope with file type filters and directory paths
- Ignoring graph memory — past learnings often contain critical context
- Assuming file paths from documentation are current — always `glob` or `ls` to confirm
