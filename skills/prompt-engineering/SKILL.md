---
name: prompt-engineering
description: |
  Best practices for effective system prompts. Use when "improve this prompt",
  "review system instructions", "optimize agent behavior", or "write agent
  instructions". Triggers on prompt review, agent optimization tasks.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Prompt Engineering for Agents

Guidelines for writing effective system prompts and agent instructions.

## When to Apply

- Reviewing or improving agent system prompts
- Writing instructions for new agents or tools
- Optimizing prompts based on evaluation results
- Analyzing prompt effectiveness

## Quick Reference: The Four Principles

| Principle                       | Do                            | Don't                         |
| ------------------------------- | ----------------------------- | ----------------------------- |
| **Right Altitude**              | Principle-based guidance      | Rigid Step 1,2,3 workflows    |
| **RFC 2119 Keywords**           | MUST/SHOULD/MAY for precision | Vague "you should" everywhere |
| **Structure Over Prescription** | When-then patterns            | Complex if-else chains        |
| **Examples Over Rules**         | Concrete demonstrations       | Abstract prescriptions        |

## RFC 2119 Keywords

| Keyword  | Meaning                        | Use For               |
| -------- | ------------------------------ | --------------------- |
| MUST     | Always required                | Security, correctness |
| MUST NOT | Absolute prohibition           | Dangerous operations  |
| SHOULD   | Strong guidance, exceptions OK | Best practices        |
| MAY      | Optional, agent discretion     | Optimizations         |

## System Prompt Template

```markdown
# Role

[What the agent is and primary function]

# Constraints

[Hard boundaries using RFC 2119]

# Tools & Integration

[When and how to use available tools]

# Decision Framework

[Principles for making choices]

# Examples

[Concrete demonstrations]
```

## How It Works

1. **Read** - Access current prompt via `read_file`
2. **Analyze** - Check for over-prescription, under-specification, conflicts
3. **Improve** - Apply principles: workflows → principles, add RFC 2119, add examples
4. **Document** - Record what changed and why
5. **Test** - Run against evaluation, compare results

## Common Anti-Patterns

| Anti-Pattern         | Example                              | Fix                                   |
| -------------------- | ------------------------------------ | ------------------------------------- |
| Prompt bloat         | Every scenario in prompt             | Extract to skills, keep principles    |
| Conflicting guidance | "Be creative and follow exact steps" | Prioritize with RFC 2119              |
| Assuming context     | "Use best practices"                 | Specify what that means               |
| Workflow addiction   | "1. Read, 2. Edit, 3. Test"          | "Understand context before modifying" |

## Best Practices

- Balance: not too rigid (can't adapt), not too vague (no guidance)
- Use RFC 2119 to distinguish hard requirements from suggestions
- Provide examples showing desired behavior, not just rules
- Separate concerns: role, constraints, tools, decisions, examples
- Test changes with evaluation harness before committing
