/**
 * Codebase Analysis Example
 *
 * Demonstrates batch file processing with error handling,
 * progress reporting, and summary generation.
 */

import { glob, readFile, grep } from "./tools-api/filesystem";
import { storeEntity } from "./tools-api/memory";

interface FileAnalysis {
  file: string;
  status: "success" | "error";
  lineCount?: number;
  todoCount?: number;
  error?: string;
}

async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  try {
    const content = await readFile({ file_path: filePath });
    const lines = content.split("\n");
    const todos = lines.filter((l) => l.includes("TODO")).length;

    return {
      file: filePath,
      status: "success",
      lineCount: lines.length,
      todoCount: todos,
    };
  } catch (error) {
    return {
      file: filePath,
      status: "error",
      error: String(error),
    };
  }
}

// Main analysis
async function main() {
  // Find all TypeScript files
  const files = await glob({ pattern: "src/**/*.ts" });
  const fileList = files.split("\n").filter((f) => f.trim());

  console.log(`Analyzing ${fileList.length} TypeScript files...`);

  // Process in batches of 5 to avoid IPC overload
  const results: FileAnalysis[] = [];
  const batchSize = 5;

  for (let i = 0; i < fileList.length; i += batchSize) {
    const batch = fileList.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(analyzeFile));
    results.push(...batchResults);

    // Progress report
    const progress = Math.min(i + batchSize, fileList.length);
    console.log(`Progress: ${progress}/${fileList.length}`);
  }

  // Generate summary (return this, not raw data)
  const successful = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "error");
  const totalLines = successful.reduce((sum, r) => sum + (r.lineCount || 0), 0);
  const totalTodos = successful.reduce((sum, r) => sum + (r.todoCount || 0), 0);

  const summary = {
    filesAnalyzed: successful.length,
    filesFailed: failed.length,
    totalLines,
    totalTodos,
    averageLinesPerFile: Math.round(totalLines / successful.length),
    topTodoFiles: successful
      .filter((r) => (r.todoCount || 0) > 0)
      .sort((a, b) => (b.todoCount || 0) - (a.todoCount || 0))
      .slice(0, 5)
      .map((r) => ({ file: r.file, todos: r.todoCount })),
  };

  // Optionally persist to memory
  await storeEntity({
    entity_type: "note",
    title: `Codebase analysis: ${new Date().toISOString().split("T")[0]}`,
    content: JSON.stringify(summary, null, 2),
    context: "codebase-analysis",
    tags: ["analysis", "automated", "metrics"],
  });

  console.log("\n=== Analysis Summary ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(console.error);
