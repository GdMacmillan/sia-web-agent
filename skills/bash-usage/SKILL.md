---
name: bash-usage
description: Bash tool usage guidelines covering directory verification, path quoting, dedicated tool preferences, command parallelism, and working directory management.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Bash Tool Usage

Operational guidelines for using the bash tool effectively and safely.

## When to Apply

- Executing shell commands (git, npm, docker, yarn, etc.)
- Running tests or build commands
- System administration tasks

## Core Rule

The bash tool is for **terminal operations only**. DO NOT use it for file operations (reading,
writing, editing, searching, finding files) — use the specialized tools instead.

## Directory Verification

Before executing commands that create new directories or files:

1. Use `ls` to verify the parent directory exists and is the correct location
2. Example: before running `mkdir foo/bar`, first use `ls foo` to check that `foo` exists

## Path Quoting

Always quote file paths that contain spaces with double quotes:

- `cd "/Users/name/My Documents"` (correct)
- `cd /Users/name/My Documents` (incorrect — will fail)
- `python "/path/with spaces/script.py"` (correct)
- `python /path/with spaces/script.py` (incorrect — will fail)

## Dedicated Tools Preference

Always prefer dedicated tools over bash commands:

| Operation      | Use This Tool | NOT This Command     |
| -------------- | ------------- | -------------------- |
| File search    | `glob`        | `find` or `ls`       |
| Content search | `grep`        | `grep` or `rg`       |
| Read files     | `read_file`   | `cat`/`head`/`tail`  |
| Edit files     | `edit_file`   | `sed`/`awk`          |
| Write files    | `write_file`  | `echo >`/`cat <<EOF` |
| Communication  | Output text   | `echo`/`printf`      |

## Command Parallelism

- **Independent commands**: Make multiple bash tool calls in a single message (parallel execution)
- **Dependent commands**: Chain with `&&` in a single call (e.g., `git add . && git commit -m "msg"`)
- Use `;` only when you need sequential execution but don't care if earlier commands fail
- DO NOT use newlines to separate commands (newlines are ok in quoted strings)

## Working Directory

Maintain your current working directory throughout the session:

- Use absolute paths instead of `cd`
- Only use `cd` if the user explicitly requests it

**Good**: `pytest /foo/bar/tests`
**Bad**: `cd /foo/bar && pytest tests`

## Timeout and Background Execution

- Default timeout: 240000ms (4 minutes), max: 600000ms (10 minutes)
- Use `run_in_background` for long-running commands you don't need to wait for
- Monitor background command output using the bash tool as it becomes available
- Never use `run_in_background` to run `sleep` — it returns immediately
- Output exceeding 30000 characters will be truncated
