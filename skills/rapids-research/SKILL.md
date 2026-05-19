---
name: rapids-research
description: |
  Evidence-based research with citations using RAPIDS methodology. Use when
  "research this topic", "find evidence for", "cite sources", or "investigate
  with references". Triggers on questions requiring corroboration.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# RAPIDS Research Workflow

Systematic 6-step approach for evidence-based research with proper citations and corroboration.

## When to Apply

- Researching topics requiring multiple sources
- Answering questions needing corroboration
- Producing reports with citations
- Investigating technical questions with attribution
- Comparing approaches with evidence

## Quick Reference: RAPIDS Steps

| Step           | Goal             | Key Actions                                            |
| -------------- | ---------------- | ------------------------------------------------------ |
| **R**efine     | Clarify question | Transform vague → specific, define acceptance criteria |
| **A**pproach   | Plan strategy    | Choose sources, tools, draft query order               |
| **P**robe      | Gather evidence  | Execute searches, preserve quotes with links           |
| **I**ntegrity  | Corroborate      | 2+ sources for critical claims, resolve conflicts      |
| **D**istill    | Synthesize       | Write concise answer with inline citations [1]         |
| **S**elf-check | Verify           | Confirm coverage, note gaps, propose next steps        |

## Corroboration Standards

| Claim Type       | Requirement                         |
| ---------------- | ----------------------------------- |
| Critical claims  | 2+ independent sources              |
| Secondary claims | 1 reputable source                  |
| Conflicts        | Document both sides, note authority |
| Gaps             | Explicitly state when incomplete    |

## Output Structure

```markdown
## Answer

[Direct response with inline citations [1], [2]]

## Sources

[1] Title/Author — URL (date)
[2] Title/Author — URL (date)

## Tool Log

- Major tool calls and purpose

## Next Steps

[Only if gaps remain]
```

## How It Works

1. **Refine** - Convert vague requests to testable claims with acceptance criteria
2. **Approach** - Select tools (`search`, web search, `read_file`) and draft query order
3. **Probe** - Execute searches, preserve quotes with permalinks/file paths
4. **Integrity** - Verify critical claims with 2+ independent sources
5. **Distill** - Write concise synthesis with inline citations
6. **Self-check** - Verify coverage against acceptance criteria, note gaps

## Best Practices

- Primary sources > secondary sources > tertiary sources
- 3-5 searches maximum per subtopic (don't over-research)
- Save evidence as you find it—don't rely on memory
- Stop when acceptance criteria are met
- Never present uncertain claims as facts
