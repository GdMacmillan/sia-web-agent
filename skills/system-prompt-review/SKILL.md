---
name: system-prompt-review
description: |
  Autonomous workflow for system prompt optimization. Use when "improve my prompts",
  "test prompt changes", "run self-improvement", or "optimize agent behavior".
  Triggers on prompt review, evaluation analysis, agent improvement tasks.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# System Prompt Review and Improvement

Structured workflow for autonomous self-improvement through prompt optimization.

## When to Apply

- Reviewing agent system prompts for issues
- Analyzing evaluation results for prompt-driven problems
- Testing prompt changes against evaluation harness
- Iterating on agent capabilities based on test results

## Quick Reference: Analysis Checklist

| Issue Type          | Signs                         | Solution                 |
| ------------------- | ----------------------------- | ------------------------ |
| Over-prescription   | Rigid Step 1,2,3 workflows    | Convert to principles    |
| Under-specification | Vague "be helpful" guidance   | Add concrete examples    |
| Conflicts           | "Be concise but thorough"     | Prioritize with RFC 2119 |
| Missing boundaries  | Unclear when to ask vs assume | Add decision framework   |

| RFC 2119 Keyword | Meaning                                |
| ---------------- | -------------------------------------- |
| MUST             | Hard requirement, always satisfied     |
| SHOULD           | Strong guidance, exceptions documented |
| MAY              | Optional, agent discretion             |
| MUST NOT         | Absolute prohibition                   |

## How It Works

1. **Retrieve** - Read `system-prompts.ts`, query memory for past attempts
2. **Analyze** - Check for over-prescription, under-specification, conflicts
3. **Identify** - Map evaluation failures to prompt issues, prioritize by impact
4. **Draft** - Apply prompt engineering: principles over workflows, RFC 2119 keywords
5. **Test** - Run evaluation (`yarn test:evaluation`), compare baseline vs modified
6. **Record** - Store outcome via `store_entity`, update status, commit if successful

## Common Improvement Patterns

| Pattern                | Symptom                  | Solution                          |
| ---------------------- | ------------------------ | --------------------------------- |
| Add examples           | Variable behavior        | Show good vs bad approaches       |
| Workflows → Principles | Can't handle edge cases  | Replace rigid steps with guidance |
| Tool boundaries        | Wrong tool selection     | Add explicit tool usage matrix    |
| RFC 2119 constraints   | Violates important rules | Change "should" to "MUST"         |

## Best Practices

- Change ONE thing at a time—isolate impact
- Always run evaluation before/after
- Record ALL attempts (success + failure) in memory
- Extract detailed workflows to skills (keeps prompts lean)
- Use data to guide decisions, not intuition

## References

- Prompt engineering: `skills/global/prompt-engineering/SKILL.md`
- Evaluation framework: `packages/agent/evaluation-results/`
- Prompt guidelines: `CLAUDE.md` (System Prompt Guidelines section)
