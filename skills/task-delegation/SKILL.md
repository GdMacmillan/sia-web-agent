---
name: task-delegation
description: |
  Guidelines for effective sub-agent delegation. Use when "should I delegate",
  "which sub-agent", "parallel research", or deciding between direct work vs
  delegation. Triggers on complex multi-step tasks.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Task Delegation Workflow

Guidelines for when and how to delegate work to specialized sub-agents.

## When to Apply

- Deciding whether to handle directly vs delegate
- Choosing appropriate sub-agent type
- Structuring parallel vs sequential delegation
- Providing structured parameters to agents

## Quick Reference: Sub-Agents

| Agent        | Purpose                              | When to Use                                 |
| ------------ | ------------------------------------ | ------------------------------------------- |
| **research** | Deep codebase investigation          | "How is X implemented?", trace dependencies |
| **plan**     | Structured implementation plans      | "Create a plan for X", design approaches    |
| **general**  | Tasks outside specialized categories | Isolated context needed, no specialist fits |

## Delegation Decision Matrix

| Scenario                           | Action               |
| ---------------------------------- | -------------------- |
| Single file read/edit              | Handle directly      |
| One-line fix                       | Handle directly      |
| Requires conversation context      | Handle directly      |
| Repository-wide exploration        | Delegate (research)  |
| Deep investigation (>5 tool calls) | Delegate (research)  |
| Multiple independent subtasks      | Delegate in parallel |
| Complex planning                   | Delegate (plan)      |

**Rule of thumb**: If task generates >50 lines of context or >5 tool calls, delegate.

## Sub-Agent Parameters

### Research Agent

```
task({
  subagent_type: "research",
  description: "Context about what to research",
  depth: "shallow|medium|deep",
  taskType: "architecture|dependency|logic|pattern|comparison",
  focusAreas: ["paths/to/focus"]
})
```

### Plan Agent

```
task({
  subagent_type: "plan",
  description: "Context about planning task",
  requirements: "What must be accomplished",
  constraints: ["Constraint 1"],
  targetFiles: ["files/to/modify"]
})
```

## How It Works

1. **Assess** - Evaluate task complexity, context requirements, tool count
2. **Choose** - Select agent type based on task nature (research/plan/general)
3. **Structure** - Provide specific parameters (depth, taskType, constraints)
4. **Launch** - Invoke via `task()` tool; multiple calls run in parallel
5. **Synthesize** - Integrate sub-agent outputs into cohesive response

## Handoff Message Format

Provide specialized agents with well-defined tasks using a compact handoff. Include:

- **Goal** — what to accomplish
- **Acceptance criteria** — how to know it's done
- **Scope** — what's in/out of bounds
- **Relevant files** — starting points
- **Known risks/assumptions** — context that matters
- **Tool plan** — suggested approach
- **Deliverables** — expected output format

## Context Management

- Prefer delegating file search to sub-agents to reduce main context usage
- Proactively use the Task tool when the task matches a sub-agent's specialty
- Never use placeholders or guess missing parameters in tool calls

## Best Practices

- Use structured parameters (depth, taskType) over vague descriptions
- Launch multiple task tools in single message for parallel execution
- Trust sub-agent structured outputs—review for integration, not correctness
- Provide complete context in description
- Don't delegate trivial tasks—overhead exceeds benefit
