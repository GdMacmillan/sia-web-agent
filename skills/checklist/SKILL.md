---
name: checklist
description: Dependency-aware checklist tools for coordinating multi-step workflows with blocking enforcement and cycle prevention.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Checklist & Dependency Tracking

Reference for the 7 checklist tools and dependency-aware workflow coordination.

## When to Apply

- Coordinating multi-step workflows with dependencies between steps
- After receiving a structured plan from the planner agent
- When task ordering matters (some steps must complete before others can start)

## Tools Reference

| Tool               | Purpose                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `create_checklist` | Create a checklist from requirements (strings or objects with `dependsOn` arrays)      |
| `get_checklist`    | Retrieve checklist state with computed statuses, layered display order, and warnings   |
| `check_item`       | Mark an item as completed (blocks if unmet dependencies exist)                         |
| `uncheck_item`     | Uncheck an item (warns about downstream completed items with now-unmet deps)           |
| `set_dependencies` | Set or update dependency list for an item (validates acyclicity, rollbacks on failure) |
| `get_ready_items`  | Get all items that are ready to work on (not blocked, not completed)                   |
| `delete_checklist` | Remove a checklist when done                                                           |

## Plan-to-Checklist Workflow

1. **Delegate planning** to the planner sub-agent — the plan includes step dependencies
2. **Create checklist** with `create_checklist`, mapping plan steps to items with `dependsOn` arrays
3. **Work loop**: call `get_ready_items` to find actionable items, work on them, then `check_item` when done
4. **Repeat** until all items are completed

## Dependency Rules

- **Blocking enforcement**: `check_item` rejects if any dependency is unchecked, returning the unmet list
- **No auto-cascade on uncheck**: Unchecking an item does NOT auto-uncheck its dependents — warnings are emitted instead
- **Status is computed**: `ready` (deps met, not checked), `blocked` (deps unmet), `completed` (checked)
- **Cycle prevention**: `create_checklist` and `set_dependencies` reject cyclic dependency graphs
