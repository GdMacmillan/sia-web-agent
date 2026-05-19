/**
 * Memory Knowledge Synthesis Example
 *
 * Demonstrates querying memory, processing results in code,
 * and creating synthesized knowledge entities.
 */

import { searchEntities, listEntities, storeEntity } from "./tools-api/memory";

interface Entity {
  id: string;
  title: string;
  content: string;
  context?: string;
  tags?: string[];
  created_at?: string;
}

async function main() {
  // Search for learnings about a topic
  const searchResult = await searchEntities({
    query: "error handling patterns",
    entity_type: "learning",
    limit: 20,
  });

  // Parse the JSON response
  let entities: Entity[];
  try {
    entities = JSON.parse(searchResult);
  } catch {
    console.log("No entities found or parse error");
    return;
  }

  console.log(`Found ${entities.length} related learnings`);

  // Group by context
  const byContext: Record<string, Entity[]> = {};
  for (const entity of entities) {
    const ctx = entity.context || "general";
    byContext[ctx] = byContext[ctx] || [];
    byContext[ctx].push(entity);
  }

  // Create synthesis document
  const sections = Object.entries(byContext).map(([context, items]) => {
    const bullets = items.map(
      (i) => `- **${i.title}**: ${i.content.slice(0, 100)}...`,
    );
    return `### ${context}\n\n${bullets.join("\n")}`;
  });

  const synthesis = `# Error Handling Patterns Synthesis

Generated: ${new Date().toISOString()} Sources: ${entities.length} learnings

${sections.join("\n\n")}

## Common Themes

${extractCommonThemes(entities)}`;

  console.log("=== Synthesized Knowledge ===");
  console.log(synthesis);

  // Store as higher-level pattern entity
  await storeEntity({
    entity_type: "pattern",
    title: "Error handling patterns synthesis",
    content: synthesis,
    context: "error-handling",
    tags: ["synthesis", "patterns", "automated"],
    priority: "high",
  });

  console.log("\nSynthesis stored to memory as pattern entity");
}

function extractCommonThemes(entities: Entity[]): string {
  // Simple keyword extraction
  const allContent = entities
    .map((e) => e.content)
    .join(" ")
    .toLowerCase();
  const keywords = [
    "try-catch",
    "async",
    "promise",
    "validation",
    "logging",
    "retry",
  ];

  const found = keywords.filter((kw) => allContent.includes(kw));
  return found.length > 0
    ? `Common keywords: ${found.join(", ")}`
    : "No common themes extracted";
}

main().catch(console.error);
