/**
 * Create Tool Example
 *
 * Demonstrates creating a reusable utility that persists
 * in the workspace for use in future executions.
 */

import { writeFile } from "./tools-api/filesystem";

async function main() {
  // Define a reusable codebase analyzer tool
  const analyzerCode = `/** * Codebase Analyzer Utility * * Reusable functions for analyzing code patterns. * Created by the
agent for future use. */

import { grep, glob } from './tools-api/filesystem';

export interface PatternMatch { pattern: string; matchCount: number; files: string[]; samples:
string[]; }

/** * Search for a pattern across the codebase */ export async function analyzePattern( pattern:
string, path: string = 'src/', fileGlob: string = '*.ts' ): Promise<PatternMatch> { const matches =
await grep({ pattern, path, glob: fileGlob }); const lines = matches.split('\\n').filter(l =>
l.trim());

  // Extract unique files const files = [...new Set(lines.map(l => l.split(':')[0]))];

  return { pattern, matchCount: lines.length, files: files.slice(0, 10), // Limit to 10 files
  samples: lines.slice(0, 5) // Limit to 5 samples }; }

/** * Find potentially unused exports */ export async function findUnusedExports(path: string =
'src/'): Promise<string[]> { // Find exported functions const exports = await grep({ pattern:
'export (async )?function (\\\\w+)', path });

  const funcNames = exports.split('\\n') .map(l => { const match = l.match(/function (\\w+)/);
  return match ? match[1] : null; }) .filter((name): name is string => name !== null);

  // Check usage of each (limit to first 20 to avoid timeout) const unused: string[] = [];

  for (const name of funcNames.slice(0, 20)) { const usages = await grep({ pattern: name, path });
  const usageCount = usages.split('\\n').filter(l => l.trim()).length;

    // If only appears once (the export itself), likely unused if (usageCount <= 1) {
    unused.push(name); } }

  return unused; }

/** * Get import graph for a file */ export async function getImports(filePath: string):
Promise<string[]> { const { readFile } = await import('./tools-api/filesystem');

  try { const content = await readFile({ file_path: filePath }); const importMatches =
  content.match(/from ['"]([^'"]+)['"]/g) || [];

    return importMatches.map(m => { const match = m.match(/['"]([^'"]+)['"]/); return match ?
    match[1] : ''; }).filter(Boolean); } catch { return []; } }`;

  // Write the tool to the workspace
  await writeFile({
    file_path: "./my-tools/codebase-analyzer.ts",
    content: analyzerCode,
  });

  console.log("Created: ./my-tools/codebase-analyzer.ts");
  console.log("");
  console.log("Available functions:");
  console.log("  - analyzePattern(pattern, path?, fileGlob?)");
  console.log("  - findUnusedExports(path?)");
  console.log("  - getImports(filePath)");
  console.log("");
  console.log("Usage in future executions:");
  console.log(
    '  import { analyzePattern } from "./my-tools/codebase-analyzer.ts";',
  );
  console.log('  const results = await analyzePattern("TODO");');
}

main().catch(console.error);
