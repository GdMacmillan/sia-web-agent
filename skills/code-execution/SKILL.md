---
name: code-execution
description: |
  Execute TypeScript/JavaScript code for data processing. Use when processing files,
  aggregating data, or performing batch operations. IMPORTANT: TypeScript only, not Python.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.1.0"
---

# Code Execution Skill

Execute TypeScript/JavaScript code with access to Node.js APIs and agent tools.

**IMPORTANT: This tool runs TypeScript/JavaScript only. Python syntax will fail.**

## When to Apply

- Processing data files (CSV, JSON, text)
- Aggregating or filtering large datasets
- Batch operations over multiple files
- Complex control flow with loops and conditionals
- Operations that benefit from code logic

## Quick Reference

| Aspect      | Details                             |
| ----------- | ----------------------------------- |
| Language    | TypeScript/JavaScript (NOT Python)  |
| Runtime     | Node.js via tsx                     |
| Working Dir | Project root (relative paths work)  |
| Timeout     | 60s default, 5 min max              |
| Output      | stdout/stderr captured (30KB limit) |

## How to Use

### Reading Files (Native Node.js)

```typescript
import { readFileSync } from "fs";

// Relative paths work - code runs from project root
const data = readFileSync("./myfile.csv", "utf-8");
const lines = data.split("\n");

// Process data
let sum = 0;
let count = 0;
for (const line of lines.slice(1)) {
  const cols = line.split(",");
  const value = parseFloat(cols[2]);
  if (!isNaN(value)) {
    sum += value;
    count++;
  }
}
console.log("Average:", sum / count);
```

### Using Tool APIs

Tools are available as typed imports from `./tools-api/`:

```typescript
import { grep, readFile } from "./tools-api/filesystem";
import { searchEntities } from "./tools-api/memory";

// Search codebase
const matches = await grep({ pattern: "TODO", path: "src/", glob: "*.ts" });
console.log(matches);

// Search memory
const entities = await searchEntities({ query: "authentication" });
console.log(entities);
```

### Tool Categories

| Category     | Tools                                                       |
| ------------ | ----------------------------------------------------------- |
| `filesystem` | `readFile`, `writeFile`, `editFile`, `grep`, `glob`, `ls`   |
| `memory`     | `searchEntities`, `storeEntity`, `listEntities`, `traverse` |
| `search`     | `search` (ripgrep-based)                                    |
| `system`     | `bash`                                                      |

## Constraints

| Constraint      | Value              |
| --------------- | ------------------ |
| Default timeout | 60 seconds         |
| Max timeout     | 5 minutes          |
| Output limit    | 30KB (truncated)   |
| Language        | TypeScript/JS only |

## Common Mistakes

- Using Python syntax (`import pandas as pd`) - use TypeScript instead
- Using absolute paths when relative paths work (`./file.csv` not `/full/path/file.csv`)
- Returning raw data instead of processed summaries
- Missing error handling for file operations

## Best Practices

- Use native Node.js `fs` for simple file reading
- Process data in code, return only summaries
- Wrap file operations in try/catch
- Use relative paths from project root
