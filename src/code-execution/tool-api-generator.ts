/**
 * Tool API Generator
 *
 * Generates TypeScript modules from tool definitions for use in code execution.
 * Creates a tools-api/ directory with typed functions that call tools via IPC.
 *
 * Directory structure:
 * tools-api/
 * ├── index.ts              # searchTools(), listCategories()
 * ├── _runtime.ts           # callTool() IPC function
 * ├── filesystem/           # Filesystem tools
 * │   ├── index.ts
 * │   ├── read_file.ts
 * │   ├── write_file.ts
 * │   └── ...
 * ├── memory/               # Memory tools
 * │   ├── index.ts
 * │   ├── search_entities.ts
 * │   └── ...
 * └── search/               # Search tools
 *     └── search.ts
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ZodObject, ZodTypeAny } from "zod";
import { logger } from "../utils/logger.js";

/**
 * Tool category mapping
 * Maps tool names to their category for directory organization
 */
const TOOL_CATEGORIES: Record<string, string> = {
  // Filesystem tools
  ls: "filesystem",
  read_file: "filesystem",
  write_file: "filesystem",
  edit_file: "filesystem",
  glob: "filesystem",
  grep: "filesystem",

  // Memory tools
  store_entity: "memory",
  retrieve_entity: "memory",
  search_entities: "memory",
  list_entities: "memory",
  update_entity_status: "memory",
  update_entity: "memory",
  traverse_graph: "memory",
  promote_entities: "memory",

  // Search tools
  search: "search",

  // Bash tools
  bash: "system",
};

/**
 * Sanitize a tool name for use as a filename by stripping path separators
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

/**
 * Get the category for a tool name
 */
function getToolCategory(toolName: string): string {
  return TOOL_CATEGORIES[toolName] || "misc";
}

/**
 * Convert tool name to function name (snake_case to camelCase)
 */
function toFunctionName(toolName: string): string {
  return toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert tool name to interface name (snake_case to PascalCase)
 */
function toInterfaceName(toolName: string): string {
  const camel = toFunctionName(toolName);
  return camel.charAt(0).toUpperCase() + camel.slice(1) + "Input";
}

/**
 * Get the internal type name from a Zod schema
 * Handles both Zod v3 (typeName) and Zod v4 (type) formats
 */
function getZodTypeName(schema: ZodTypeAny): string | undefined {
  const def = (schema as any)._def;

  // Zod v3 style: def.typeName
  if (def?.typeName) {
    return def.typeName;
  }

  // Zod v4 style: def.type as string or def.innerType for wrappers
  if (def?.type) {
    // In Zod v4, 'type' is a string like 'string', 'number', etc.
    if (typeof def.type === "string") {
      return `Zod${def.type.charAt(0).toUpperCase() + def.type.slice(1)}`;
    }
    // Or it could be a nested schema (for arrays)
    if (typeof def.type === "object") {
      return "ZodArray";
    }
  }

  // Handle optional wrapper in Zod v4
  if (def?.innerType && !def?.type) {
    // This is an optional or default wrapper
    const innerDef = (def.innerType as any)?._def;
    if (innerDef?.defaultValue !== undefined) {
      return "ZodDefault";
    }
    return "ZodOptional";
  }

  return undefined;
}

/**
 * Check if a schema is optional or has a default (handles Zod v3 and v4)
 */
function isOptionalOrDefault(schema: ZodTypeAny): boolean {
  const def = (schema as any)._def;
  const typeName = getZodTypeName(schema);

  // Check for explicit optional/default type names
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return true;
  }

  // Zod v4 style: check for innerType with optional flag
  if (def?.innerType) {
    return true;
  }

  return false;
}

/**
 * Get the inner schema from an optional/default wrapper
 */
function getInnerSchema(schema: ZodTypeAny): ZodTypeAny | undefined {
  const def = (schema as any)._def;
  return def?.innerType;
}

/**
 * Extract type information from a Zod schema
 * Handles both Zod v3 and Zod v4 internal structures
 */
function zodToTypeScript(schema: ZodTypeAny, depth = 0): string {
  const def = (schema as any)._def;
  const typeName = getZodTypeName(schema);

  // Handle optional wrapper
  if (typeName === "ZodOptional") {
    const inner = getInnerSchema(schema);
    if (inner) return zodToTypeScript(inner, depth);
  }

  // Handle default wrapper
  if (typeName === "ZodDefault") {
    const inner = getInnerSchema(schema);
    if (inner) return zodToTypeScript(inner, depth);
  }

  // Zod v4: Check def.type as string directly
  if (def?.type && typeof def.type === "string") {
    switch (def.type) {
      case "string":
        return "string";
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "undefined":
        return "undefined";
      case "any":
        return "any";
      case "unknown":
        return "unknown";
      case "void":
        return "void";
    }
  }

  // Zod v3 style: Basic types by typeName
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodNull":
      return "null";
    case "ZodUndefined":
      return "undefined";
    case "ZodAny":
      return "any";
    case "ZodUnknown":
      return "unknown";
    case "ZodVoid":
      return "void";

    case "ZodLiteral": {
      const literalValue = def?.value;
      return typeof literalValue === "string"
        ? `"${literalValue}"`
        : String(literalValue);
    }

    case "ZodEnum": {
      const values = def?.values as string[] | undefined;
      if (values) {
        return values.map((v) => `"${v}"`).join(" | ");
      }
      return "string";
    }

    case "ZodArray": {
      // Zod v4: def.type is the element schema
      const elementType = def?.type;
      if (elementType && typeof elementType === "object") {
        return `${zodToTypeScript(elementType, depth)}[]`;
      }
      // Zod v3 fallback
      if (def?.items) {
        return `${zodToTypeScript(def.items, depth)}[]`;
      }
      return "any[]";
    }

    case "ZodRecord": {
      const valueType = def?.valueType;
      if (valueType) {
        return `Record<string, ${zodToTypeScript(valueType, depth)}>`;
      }
      return "Record<string, any>";
    }

    case "ZodObject": {
      const shape = (schema as ZodObject<any>).shape;
      if (!shape) return "object";

      const indent = "  ".repeat(depth + 1);
      const closeIndent = "  ".repeat(depth);

      const props = Object.entries(shape).map(([key, value]) => {
        const isOpt = isOptionalOrDefault(value as ZodTypeAny);
        const typeStr = zodToTypeScript(value as ZodTypeAny, depth + 1);
        const optionalMark = isOpt ? "?" : "";
        return `${indent}${key}${optionalMark}: ${typeStr};`;
      });

      return `{\n${props.join("\n")}\n${closeIndent}}`;
    }

    case "ZodUnion": {
      const options = def?.options as ZodTypeAny[] | undefined;
      if (options) {
        return options.map((opt) => zodToTypeScript(opt, depth)).join(" | ");
      }
      return "any";
    }

    case "ZodIntersection": {
      const left = def?.left;
      const right = def?.right;
      if (left && right) {
        return `${zodToTypeScript(left, depth)} & ${zodToTypeScript(right, depth)}`;
      }
      return "any";
    }

    case "ZodTuple": {
      const items = def?.items as ZodTypeAny[] | undefined;
      if (items) {
        return `[${items.map((item) => zodToTypeScript(item, depth)).join(", ")}]`;
      }
      return "any[]";
    }

    case "ZodNullable": {
      const inner = def?.innerType;
      if (inner) {
        return `${zodToTypeScript(inner, depth)} | null`;
      }
      return "any | null";
    }

    default:
      // Fallback for unknown types
      return "any";
  }
}

/**
 * Get description from a Zod schema (handles both v3 and v4)
 */
function getZodDescription(schema: ZodTypeAny): string {
  const def = (schema as any)?._def;

  // Zod v3 style
  if (def?.description) {
    return def.description;
  }

  // Zod v4 style - description might be in checks
  if (def?.checks) {
    for (const check of def.checks) {
      if (check.kind === "description") {
        return check.value;
      }
    }
  }

  return "";
}

/**
 * Generate TypeScript interface from Zod schema
 */
function generateInterface(
  toolName: string,
  schema: ZodObject<any>,
): { name: string; definition: string; properties: PropertyInfo[] } {
  const interfaceName = toInterfaceName(toolName);
  const shape = schema.shape;
  const properties: PropertyInfo[] = [];

  const props = Object.entries(shape).map(([key, value]) => {
    const zodSchema = value as ZodTypeAny;
    const isOptional = isOptionalOrDefault(zodSchema);
    const typeStr = zodToTypeScript(zodSchema);
    const description = getZodDescription(zodSchema);
    const optionalMark = isOptional ? "?" : "";

    properties.push({
      name: key,
      type: typeStr,
      optional: isOptional,
      description,
    });

    const docComment = description ? `  /** ${description} */\n` : "";
    return `${docComment}  ${key}${optionalMark}: ${typeStr};`;
  });

  const definition = `export interface ${interfaceName} {\n${props.join("\n")}\n}`;

  return { name: interfaceName, definition, properties };
}

interface PropertyInfo {
  name: string;
  type: string;
  optional: boolean;
  description: string;
}

/**
 * Generate a tool module file content
 */
function generateToolModule(
  toolName: string,
  description: string,
  schema: ZodObject<any>,
): string {
  const functionName = toFunctionName(toolName);
  const interfaceInfo = generateInterface(toolName, schema);

  const lines: string[] = [
    "/**",
    ` * ${toolName} tool`,
    " *",
    ` * ${description}`,
    " */",
    "",
    "import { callTool } from '../_runtime.js';",
    "",
    interfaceInfo.definition,
    "",
    "/**",
    ` * ${description}`,
  ];

  // Add parameter documentation
  for (const prop of interfaceInfo.properties) {
    if (prop.description) {
      const optionalTag = prop.optional ? " (optional)" : "";
      lines.push(
        ` * @param input.${prop.name}${optionalTag} ${prop.description}`,
      );
    }
  }

  lines.push(
    " * @returns Promise resolving to the tool result",
    " */",
    `export async function ${functionName}(input: ${interfaceInfo.name}): Promise<string> {`,
    `  return callTool('${toolName}', input);`,
    "}",
    "",
  );

  return lines.join("\n");
}

/**
 * Generate category index file
 */
function generateCategoryIndex(
  category: string,
  tools: { name: string; functionName: string }[],
): string {
  const lines: string[] = ["/**", ` * ${category} tools`, " */", ""];

  for (const tool of tools) {
    lines.push(`export { ${tool.functionName} } from './${tool.name}.js';`);
    lines.push(
      `export type { ${toInterfaceName(tool.name)} } from './${tool.name}.js';`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the runtime module with IPC bridge
 */
function generateRuntimeModule(ipcSocketPath: string): string {
  return `/** * Tool API Runtime * * Provides the callTool function that communicates with the parent process
* via IPC to execute actual tool implementations. * * This file is generated by
tool-api-generator.ts */

import { createConnection } from 'net';

const IPC_SOCKET_PATH = ${JSON.stringify(ipcSocketPath)};

interface IPCRequest { id: string; method: 'tool_call'; params: { tool_name: string; input: any; };
}

interface IPCResponse { id: string; result?: any; error?: { code: number; message: string; data?:
any; }; }

let requestId = 0; const pendingRequests = new Map<string, { resolve: (value: any) => void; reject:
(error: Error) => void; }>();

let client: ReturnType<typeof createConnection> | null = null; let connectionPromise: Promise<void>
| null = null; let messageBuffer = '';

/** * Ensure IPC connection is established */ async function ensureConnection(): Promise<void> { if
(client && !client.destroyed) { return; }

  if (connectionPromise) { return connectionPromise; }

  connectionPromise = new Promise((resolve, reject) => { client = createConnection(IPC_SOCKET_PATH);

    client.on('connect', () => { resolve(); });

    client.on('data', (data: Buffer) => { messageBuffer += data.toString();

      // Process complete messages (newline-delimited JSON) const lines =
      messageBuffer.split('\\n'); messageBuffer = lines.pop() || '';

      for (const line of lines) { if (!line.trim()) continue;

        try { const response: IPCResponse = JSON.parse(line); const pending =
        pendingRequests.get(response.id);

          if (pending) { pendingRequests.delete(response.id);

            if (response.error) { pending.reject(new Error(response.error.message)); } else {
            pending.resolve(response.result); } } } catch (e) { console.error('Failed to parse IPC
            response:', e); } } });

    client.on('error', (err: Error) => { connectionPromise = null; reject(err); });

    client.on('close', () => { connectionPromise = null; client = null;

      // Reject all pending requests for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('IPC connection closed')); pendingRequests.delete(id); } }); });

  return connectionPromise; }

/** * Call a tool via IPC * * @param toolName The name of the tool to call * @param input The input
parameters for the tool * @returns Promise resolving to the tool result */ export async function
callTool(toolName: string, input: any): Promise<string> { await ensureConnection();

  const id = String(++requestId);

  const request: IPCRequest = { id, method: 'tool_call', params: { tool_name: toolName, input, }, };

  return new Promise((resolve, reject) => { pendingRequests.set(id, { resolve, reject });

    const message = JSON.stringify(request) + '\\n'; client!.write(message, (err: Error | undefined)
    => { if (err) { pendingRequests.delete(id); reject(err); } });

    // Timeout after 5 minutes setTimeout(() => { if (pendingRequests.has(id)) {
    pendingRequests.delete(id); reject(new Error(\`Tool call '\${toolName}' timed out\`)); } },
    300000); }); }

/** * Close the IPC connection */ export function closeConnection(): void { if (client) {
client.end(); client = null; } connectionPromise = null; }`;
}

/**
 * Generate the main index file with discovery functions
 */
function generateMainIndex(
  categories: Map<string, { name: string; functionName: string }[]>,
): string {
  const lines: string[] = [
    "/**",
    " * Tool APIs",
    " *",
    " * Provides typed TypeScript functions that call agent tools via IPC.",
    " * Use searchTools() to discover available tools by keyword.",
    " */",
    "",
  ];

  // Re-export from categories
  for (const [category, tools] of categories) {
    lines.push(`// ${category} tools`);
    for (const tool of tools) {
      lines.push(
        `export { ${tool.functionName} } from './${category}/${tool.name}.js';`,
      );
    }
    lines.push("");
  }

  // Generate tool metadata for search
  const allTools: { name: string; category: string; functionName: string }[] =
    [];
  for (const [category, tools] of categories) {
    for (const tool of tools) {
      allTools.push({ ...tool, category });
    }
  }

  lines.push("/**");
  lines.push(" * Metadata for all available tools");
  lines.push(" */");
  lines.push("const TOOL_METADATA = [");
  for (const tool of allTools) {
    lines.push(
      `  { name: '${tool.name}', category: '${tool.category}', functionName: '${tool.functionName}' },`,
    );
  }
  lines.push("];");
  lines.push("");

  // searchTools function
  lines.push("/**");
  lines.push(" * Search for tools by keyword");
  lines.push(" * @param keyword Search term to match against tool names");
  lines.push(" * @returns Array of matching tool metadata");
  lines.push(" */");
  lines.push(
    "export function searchTools(keyword: string): Array<{ name: string; category: string; functionName: string }> {",
  );
  lines.push("  const lower = keyword.toLowerCase();");
  lines.push("  return TOOL_METADATA.filter(t => ");
  lines.push("    t.name.toLowerCase().includes(lower) || ");
  lines.push("    t.category.toLowerCase().includes(lower) ||");
  lines.push("    t.functionName.toLowerCase().includes(lower)");
  lines.push("  );");
  lines.push("}");
  lines.push("");

  // listCategories function
  lines.push("/**");
  lines.push(" * List all tool categories");
  lines.push(" * @returns Array of category names");
  lines.push(" */");
  lines.push("export function listCategories(): string[] {");
  lines.push(
    `  return [${Array.from(categories.keys())
      .map((c) => `'${c}'`)
      .join(", ")}];`,
  );
  lines.push("}");
  lines.push("");

  // listTools function
  lines.push("/**");
  lines.push(" * List all available tools");
  lines.push(
    " * @returns Array of tool metadata with name, category, and function name",
  );
  lines.push(" */");
  lines.push(
    "export function listTools(): Array<{ name: string; category: string; functionName: string }> {",
  );
  lines.push("  return [...TOOL_METADATA];");
  lines.push("}");
  lines.push("");

  // Re-export runtime
  lines.push("export { callTool, closeConnection } from './_runtime.js';");
  lines.push("");

  return lines.join("\n");
}

/**
 * Options for generating tool APIs
 */
export interface GenerateToolAPIsOptions {
  /** Tools to generate APIs for */
  tools: StructuredToolInterface[];
  /** Output directory for generated files */
  outputDir: string;
  /** IPC socket path for runtime communication */
  ipcSocketPath: string;
}

/**
 * Generate tool API modules from tool definitions
 *
 * Creates a directory structure with typed TypeScript modules
 * that call tools via IPC bridge.
 */
export async function generateToolAPIs(
  options: GenerateToolAPIsOptions,
): Promise<{ toolCount: number; categories: string[] }> {
  const { tools, outputDir, ipcSocketPath } = options;

  // Resolve outputDir to an absolute path for containment checks
  const resolvedOutputDir = resolve(outputDir);

  /**
   * Validate that a resolved path is contained within the output directory.
   * Throws if the path escapes the output directory boundary.
   */
  function assertPathContained(filePath: string): void {
    const resolvedPath = resolve(filePath);
    if (
      !resolvedPath.startsWith(resolvedOutputDir + "/") &&
      resolvedPath !== resolvedOutputDir
    ) {
      throw new Error(
        `Path traversal detected: ${filePath} resolves outside ${resolvedOutputDir}`,
      );
    }
  }

  // Group tools by category, sanitizing names for filesystem use
  const categories = new Map<
    string,
    { name: string; functionName: string; tool: StructuredToolInterface }[]
  >();

  for (const tool of tools) {
    const safeName = sanitizeFileName(tool.name);
    const category = getToolCategory(tool.name);
    const existing = categories.get(category) || [];
    existing.push({
      name: safeName,
      functionName: toFunctionName(tool.name),
      tool,
    });
    categories.set(category, existing);
  }

  // Create output directory
  if (!existsSync(resolvedOutputDir)) {
    mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // Generate runtime module
  const runtimePath = join(resolvedOutputDir, "_runtime.ts");
  assertPathContained(runtimePath);
  const runtimeContent = generateRuntimeModule(ipcSocketPath);
  writeFileSync(runtimePath, runtimeContent);

  // Generate category directories and tool modules
  for (const [category, categoryTools] of categories) {
    const categoryDir = join(resolvedOutputDir, category);
    assertPathContained(categoryDir);
    if (!existsSync(categoryDir)) {
      mkdirSync(categoryDir, { recursive: true });
    }

    // Generate individual tool modules
    for (const { name, tool } of categoryTools) {
      try {
        // Get schema from tool
        const schema = tool.schema;
        if (!schema || typeof schema !== "object") {
          logger.warn(`Tool ${name} has no valid schema, skipping`);
          continue;
        }

        const moduleContent = generateToolModule(
          name,
          tool.description || "",
          schema as ZodObject<any>,
        );
        const modulePath = join(categoryDir, `${name}.ts`);
        assertPathContained(modulePath);
        writeFileSync(modulePath, moduleContent);
      } catch (error) {
        logger.warn(`Failed to generate module for tool ${name}: ${error}`);
      }
    }

    // Generate category index
    const categoryIndex = generateCategoryIndex(
      category,
      categoryTools.map((t) => ({
        name: t.name,
        functionName: t.functionName,
      })),
    );
    const categoryIndexPath = join(categoryDir, "index.ts");
    assertPathContained(categoryIndexPath);
    writeFileSync(categoryIndexPath, categoryIndex);
  }

  // Generate main index
  const mainIndex = generateMainIndex(
    new Map(
      Array.from(categories.entries()).map(([cat, tools]) => [
        cat,
        tools.map((t) => ({ name: t.name, functionName: t.functionName })),
      ]),
    ),
  );
  const mainIndexPath = join(resolvedOutputDir, "index.ts");
  assertPathContained(mainIndexPath);
  writeFileSync(mainIndexPath, mainIndex);

  return {
    toolCount: tools.length,
    categories: Array.from(categories.keys()),
  };
}

/**
 * Add a custom tool category mapping
 */
export function registerToolCategory(toolName: string, category: string): void {
  TOOL_CATEGORIES[toolName] = category;
}

// Export utilities for testing
export { toFunctionName, toInterfaceName, zodToTypeScript, getToolCategory };
