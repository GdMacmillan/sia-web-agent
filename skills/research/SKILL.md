---
name: research
description: |
  Systematic codebase investigation methodology. Use when "analyze the codebase",
  "trace dependencies", "investigate architecture", or "how is X implemented".
  Triggers on architecture, dependency, logic, pattern, comparison queries.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Research Agent Workflow

Deep, systematic codebase investigation returning structured findings with evidence.

## When to Apply

- Investigating how a feature is implemented
- Tracing import chains or module dependencies
- Understanding system architecture or design patterns
- Comparing implementations across files or modules
- Finding recurring patterns or anti-patterns

## Quick Reference

| Depth   | Files | Dependencies | Use When                        |
| ------- | ----- | ------------ | ------------------------------- |
| shallow | 3-5   | Surface only | Quick lookup, specific question |
| medium  | 10-15 | One level    | Feature investigation           |
| deep    | 20+   | Full chains  | Architecture analysis           |

| Task Type    | Focus                                                   |
| ------------ | ------------------------------------------------------- |
| architecture | Directory structure, module boundaries, entry points    |
| dependency   | Import chains, coupling, initialization order           |
| logic        | Control flow, state transformations, edge cases         |
| pattern      | Recurring structures, naming conventions, anti-patterns |
| comparison   | Side-by-side differences, pros/cons, migration          |

## How It Works

1. **Scope** - Match depth to task (shallow/medium/deep) based on input parameters
2. **Search** - Use `search`, `grep`, `glob` to find relevant code patterns
3. **Read** - Use `read_file` to examine implementations in detail
4. **Cite** - Always include file paths and line numbers as evidence
5. **Synthesize** - Group findings by theme, identify cross-file patterns

## Output Schema

```json
{
  "summary": "Executive summary (2-3 sentences)",
  "codebaseStructure": {
    "relevantPaths": ["paths/found"],
    "keyComponents": [{ "name": "", "path": "", "purpose": "" }],
    "dependencies": [
      { "from": "", "to": "", "type": "import|inheritance|composition" }
    ]
  },
  "findings": [
    {
      "title": "",
      "description": "",
      "evidence": "code snippet",
      "filePath": "",
      "lineNumber": 0
    }
  ],
  "recommendations": ["actionable items"],
  "issues": [
    { "severity": "high|medium|low", "description": "", "location": "" }
  ]
}
```

## Best Practices

- Match depth to task complexity—don't over-research shallow requests
- Make parallel tool calls for independent searches
- Prioritize `focusAreas` from input parameters
- Quote relevant code snippets as evidence
- Surface issues discovered during investigation
