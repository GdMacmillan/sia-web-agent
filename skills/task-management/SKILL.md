---
name: task-management
description: Task management patterns for write_todos tool covering planning, tracking progress, and breaking down complex tasks.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Task Management with write_todos

Detailed usage patterns and examples for the write_todos tool.

## When to Apply

- Planning multi-step tasks
- Tracking progress on complex work
- Giving the user visibility into what you're doing
- Breaking down large tasks into actionable steps

## Key Rules

1. **Plan early** — Use write_todos at the start of any non-trivial task
2. **Mark in_progress** — Update status when you begin working on a todo
3. **Mark completed immediately** — Do not batch completions; mark each todo done as soon as it's finished
4. **Break down complexity** — Split large tasks into smaller, trackable steps
5. **Update as you learn** — Add new todos when you discover additional work needed

## Workflow Example: Research Task

```
User: Read these 3 files and research the middleware config.

1. write_todos:
   - Read file A
   - Read file B
   - Read file C
   - Research middleware configuration
   - Confirm tool access for sub-agents

2. Mark "Read file A" as in_progress → read it → mark completed
3. Mark "Read file B" as in_progress → read it → mark completed
4. Mark "Read file C" as in_progress → read it → mark completed
5. Delegate research to researcher sub-agent
6. Mark research todo as completed
7. Summarize findings to user
```

## Workflow Example: Fix-and-Verify Task

```
User: Run the unit tests and fix whatever problems you find.

1. Delegate planning to planner if unfamiliar with test harness
2. write_todos from the plan:
   - Run unit tests
   - Interpret results

3. Run tests → discover 2 failures
4. Add new todos:
   - Fix test A
   - Fix test B

5. Fix each test, marking in_progress → completed
6. Re-run tests to verify all passing
7. Report results to user
```

## Anti-Patterns

- Writing todos but never marking them completed
- Batching all completions at the end
- Skipping write_todos for "simple" tasks that turn out to be complex
- Not updating the todo list when scope changes mid-task
