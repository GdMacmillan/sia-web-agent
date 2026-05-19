---
name: find-replace
description: |
  Systematic workflow for codebase-wide text replacement. Use when "rename this
  function", "update all imports", "replace X with Y", or "refactor pattern".
  Triggers on renaming, migration, consistent changes across files.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Find and Replace Workflow

Systematic approach for safely replacing text patterns across codebases.

## When to Apply

- Renaming variables, functions, classes, or types
- Updating API calls or method signatures
- Refactoring import paths or config keys
- Migrating from one library/pattern to another
- Making consistent textual changes across files

## Quick Reference: Occurrence Categories

| Category       | Example                      | Action                 |
| -------------- | ---------------------------- | ---------------------- |
| Definition     | `function oldName()`         | Replace first (source) |
| Export         | `export { oldName }`         | Replace second         |
| Import         | `import { oldName }`         | Replace third          |
| Usage          | `oldName(args)`              | Replace fourth         |
| Type           | `ReturnType<typeof oldName>` | Replace with usages    |
| String literal | `"oldName"` in logs          | Evaluate individually  |
| Comment        | `// calls oldName`           | Update if meaningful   |

## Replacement Order

1. Definitions → 2. Exports → 3. Imports → 4. Usages → 5. Types → 6. Strings/Comments

This order prevents temporary broken states during refactor.

## How It Works

1. **Search** - Find all occurrences with `search` or `grep`; check case variations
2. **Categorize** - Group by type (definition, usage, import, etc.)
3. **Plan** - Order replacements: definitions → exports → imports → usages
4. **Execute** - Use `edit_file` with enough context for unique matching
5. **Verify** - After each edit, use `read_file` to confirm change
6. **Finalize** - Re-search old pattern (expect 0), search new pattern (expect N)

## Case Variations to Check

When renaming `userId` → `memberId`, also check:

- `UserId` → `MemberId` (PascalCase)
- `USER_ID` → `MEMBER_ID` (SCREAMING_SNAKE)
- `user_id` → `member_id` (snake_case)

## Best Practices

- Search before replace—understand full scope first
- Include enough context in `old_string` to ensure uniqueness
- Preserve exact indentation character-for-character
- One logical change per edit—don't combine unrelated changes
- Handle partial word matches by starting with most specific patterns

## Common Pitfalls

| Pitfall              | Example                  | Solution                          |
| -------------------- | ------------------------ | --------------------------------- |
| Too generic          | `old_string: "id"`       | Include context: `userId: string` |
| Skip verification    | Move on without checking | Always `read_file` after edit     |
| Ignore case variants | Only handle `userId`     | Check `UserId`, `USER_ID` too     |
| Replace blindly      | Edit without searching   | Search first, plan systematically |
