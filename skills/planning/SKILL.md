---
name: planning
description: |
  Structured implementation planning methodology. Use when "create a plan",
  "design an approach", "break down this task", or "how should I implement X".
  Triggers on implementation, refactoring, feature development requests.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Plan Agent Workflow

Create structured, actionable implementation plans with ordered steps and dependencies.

## When to Apply

- Breaking down complex tasks into steps
- Designing implementation approaches
- Planning refactoring or migration work
- Creating file change specifications
- Identifying risks and assumptions

## Quick Reference

| Step Property | Guideline                     |
| ------------- | ----------------------------- |
| Atomic        | One logical change per step   |
| Testable      | Clear success criteria        |
| Ordered       | Dependencies explicit         |
| Specific      | File paths and function names |

| Input Parameter | Purpose                       |
| --------------- | ----------------------------- |
| requirements    | What must be accomplished     |
| constraints     | Limitations to consider       |
| targetFiles     | Files expected to be modified |

## How It Works

1. **Parse requirements** - Identify core requirements, acceptance criteria, constraints
2. **Gather context** - Use `search`, `read_file` to find existing patterns
3. **Query memory** - Check for past learnings via `search_entities`
4. **Structure plan** - Break into atomic steps with explicit dependencies
5. **Assess risks** - Identify breaking changes, edge cases, security concerns

## Output Schema

```json
{
  "summary": "High-level plan summary (1-2 sentences)",
  "steps": [
    {
      "id": "step-1",
      "description": "What needs to be done",
      "expectedOutcome": "Success criteria",
      "fileChanges": [
        {
          "path": "path/to/file.ts",
          "changeType": "create|modify|delete",
          "description": "What changes"
        }
      ],
      "dependencies": ["step-ids"]
    }
  ],
  "risks": ["Potential challenges"],
  "assumptions": ["What's being assumed"]
}
```

## Best Practices

- Search memory first for similar past plans
- Follow existing codebase patterns and conventions
- Keep steps small—easier to implement and verify
- Include verification criteria for each step
- Flag uncertainties explicitly rather than hiding them
