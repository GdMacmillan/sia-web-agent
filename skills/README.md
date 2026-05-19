# Skills System

This directory contains agent skills following Anthropic's skills pattern with progressive disclosure.

## What are Skills?

Skills are structured workflows and standard operating procedures (SOPs) that agents can access when needed. Each skill:

- Has a YAML front matter with `name` and `description`
- Contains markdown-formatted instructions
- Can include supporting files (scripts, configs, reference docs)

## How Skills Work

**Progressive Disclosure Pattern**:

1. YAML front matter (name + description) is loaded into the agent's system prompt
2. Agent sees what skills are available and when to use them
3. When a skill is relevant, agent reads the full SKILL.md file using `read_file`
4. Agent follows the workflow described in the skill

This keeps system prompts lean while making detailed workflows accessible on-demand.

## Directory Structure

```
skills/
├── README.md                                # This file
├── global/                                  # Skills available to all agents
│   ├── rapids-research/
│   │   └── SKILL.md                        # RAPIDS research methodology
│   ├── prompt-engineering/
│   │   └── SKILL.md                        # Prompt engineering best practices
│   └── task-delegation/
│       └── SKILL.md                        # Guidelines for task delegation
└── self-improvement/                        # Self-improvement focused skills
    ├── system-prompt-review/
    │   └── SKILL.md                        # Autonomous prompt review workflow
    ├── evaluation-analysis/
    │   └── SKILL.md                        # (Future) Analyze evaluation results
    └── agent-testing/
        └── SKILL.md                        # (Future) Test agent changes
```

## Creating a New Skill

1. **Create a directory** in the appropriate category (`global/` or `self-improvement/`)
2. **Write a SKILL.md file** with this structure:

```markdown
---
name: skill-name
description: Brief description of what this skill does
---

# Skill Title

## When to Use This Skill

- Scenario 1
- Scenario 2

## Workflow

### Step 1: First Action

[Instructions...]

### Step 2: Second Action

[Instructions...]

## Best Practices

- Practice 1
- Practice 2

## Examples

[Concrete demonstrations]
```

3. **Optional**: Add supporting files (Python scripts, config files, reference docs)

## Skill Categories

### Global Skills

Universal skills applicable across all agent types and tasks:

- Research workflows
- Prompt engineering
- Task delegation patterns

### Self-Improvement Skills

Skills focused on autonomous agent self-improvement:

- System prompt review and optimization
- Evaluation analysis
- Agent testing and validation

## Skill Guidelines

**DO**:

- Write clear, actionable workflows
- Include concrete examples
- Document prerequisites
- Specify when to use the skill
- Keep instructions focused and specific

**DON'T**:

- Create overly rigid step-by-step procedures (prefer principles)
- Duplicate content across skills
- Assume knowledge not in the skill
- Make skills too long (split into multiple if needed)

## Integration with Agent System

Skills are loaded by `SkillsMiddleware` which:

1. Scans this directory on agent startup
2. Parses YAML front matter from each SKILL.md
3. Injects skill summaries into system prompts
4. Agent reads full skills via existing `read_file` tool

See `packages/agent/src/middleware/skills.ts` for implementation details.

## References

- Based on Anthropic's skills pattern: https://docs.anthropic.com/en/docs/agents
- Implementation from DeepAgents CLI: `~/projects/deepagents/libs/deepagents-cli/`
- Skills video transcript: `skills-video-transcript.txt`
