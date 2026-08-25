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
import { join, resolve, relative, isAbsolute, sep } from "path";
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
 * Escape text for safe interpolation inside a JSDoc block comment.
 *
 * A description containing an asterisk-slash sequence (escaped here as
 * `*\/`) would otherwise terminate the generated comment early and turn the
 * rest of the text into (invalid) code. Escaping the slash keeps the sequence
 * inert while staying readable; already-escaped text is left unchanged.
 */
function escapeJsDocText(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

/**
 * Get description from a Zod schema.
 *
 * Uses the public `.description` getter, which is stable across Zod major
 * versions (internal `_def` layouts are not).
 */
function getZodDescription(schema: ZodTypeAny): string {
  return (schema as any)?.description ?? "";
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

    const docComment = description
      ? `  /** ${escapeJsDocText(description)} */\n`
      : "";
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
  // Tool and property descriptions are uncontrolled text; escape them at
  // every point where they land inside a generated block comment.
  const safeDescription = escapeJsDocText(description);

  const lines: string[] = [
    "/**",
    ` * ${toolName} tool`,
    " *",
    ` * ${safeDescription}`,
    " */",
    "",
    "import { callTool } from '../_runtime.js';",
    "",
    interfaceInfo.definition,
    "",
    "/**",
    ` * ${safeDescription}`,
  ];

  // Add parameter documentation
  for (const prop of interfaceInfo.properties) {
    if (prop.description) {
      const optionalTag = prop.optional ? " (optional)" : "";
      lines.push(
        ` * @param input.${prop.name}${optionalTag} ${escapeJsDocText(prop.description)}`,
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
 *
 * Emits exactly one output line per push argument so an external formatter
 * reflowing this source cannot merge emitted lines into invalid TypeScript.
 */
function generateRuntimeModule(ipcSocketPath: string): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Tool API Runtime");
  lines.push(" *");
  lines.push(" * Provides the callTool function that communicates with the parent");
  lines.push(" * process via IPC to execute actual tool implementations.");
  lines.push(" *");
  lines.push(" * This file is generated by tool-api-generator.ts");
  lines.push(" */");
  lines.push("");
  lines.push("import { createConnection } from 'net';");
  lines.push("");
  lines.push(`const IPC_SOCKET_PATH = ${JSON.stringify(ipcSocketPath)};`);
  lines.push("");
  lines.push("interface IPCRequest {");
  lines.push("  id: string;");
  lines.push("  method: 'tool_call';");
  lines.push("  params: {");
  lines.push("    tool_name: string;");
  lines.push("    input: unknown;");
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push("interface IPCResponse {");
  lines.push("  id: string;");
  lines.push("  result?: any;");
  lines.push("  error?: {");
  lines.push("    code: number;");
  lines.push("    message: string;");
  lines.push("    data?: any;");
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push("let requestId = 0;");
  lines.push("const pendingRequests = new Map<string, {");
  lines.push("  resolve: (value: any) => void;");
  lines.push("  reject: (error: Error) => void;");
  lines.push("}>();");
  lines.push("");
  lines.push("let client: ReturnType<typeof createConnection> | null = null;");
  lines.push("let connectionPromise: Promise<void> | null = null;");
  lines.push("let messageBuffer = '';");
  lines.push("");
  lines.push("/**");
  lines.push(" * Keep the socket referenced only while calls are pending so the");
  lines.push(" * process can exit naturally once user code finishes.");
  lines.push(" */");
  lines.push("function updateSocketRef(): void {");
  lines.push("  if (!client) return;");
  lines.push("  if (pendingRequests.size > 0) {");
  lines.push("    client.ref();");
  lines.push("  } else {");
  lines.push("    client.unref();");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("/**");
  lines.push(" * Ensure IPC connection is established");
  lines.push(" */");
  lines.push("async function ensureConnection(): Promise<void> {");
  lines.push("  if (client && !client.destroyed) {");
  lines.push("    return;");
  lines.push("  }");
  lines.push("");
  lines.push("  if (connectionPromise) {");
  lines.push("    return connectionPromise;");
  lines.push("  }");
  lines.push("");
  lines.push("  connectionPromise = new Promise((resolve, reject) => {");
  lines.push("    client = createConnection(IPC_SOCKET_PATH);");
  lines.push("");
  lines.push("    client.on('connect', () => {");
  lines.push("      resolve();");
  lines.push("    });");
  lines.push("");
  lines.push("    client.on('data', (data: Buffer) => {");
  lines.push("      messageBuffer += data.toString();");
  lines.push("");
  lines.push("      // Process complete messages (newline-delimited JSON)");
  lines.push('      const lines = messageBuffer.split("\\n");');
  lines.push("      messageBuffer = lines.pop() || '';");
  lines.push("");
  lines.push("      for (const line of lines) {");
  lines.push("        if (!line.trim()) continue;");
  lines.push("");
  lines.push("        try {");
  lines.push("          const response: IPCResponse = JSON.parse(line);");
  lines.push("          const pending = pendingRequests.get(response.id);");
  lines.push("");
  lines.push("          if (pending) {");
  lines.push("            pendingRequests.delete(response.id);");
  lines.push("");
  lines.push("            if (response.error) {");
  lines.push("              pending.reject(new Error(response.error.message));");
  lines.push("            } else {");
  lines.push("              pending.resolve(response.result);");
  lines.push("            }");
  lines.push("          }");
  lines.push("        } catch (e) {");
  lines.push('          console.error("Failed to parse IPC response:", e);');
  lines.push("        }");
  lines.push("      }");
  lines.push("");
  lines.push("      updateSocketRef();");
  lines.push("    });");
  lines.push("");
  lines.push("    client.on('error', (err: Error) => {");
  lines.push("      connectionPromise = null;");
  lines.push("      reject(err);");
  lines.push("    });");
  lines.push("");
  lines.push("    client.on('close', () => {");
  lines.push("      connectionPromise = null;");
  lines.push("      client = null;");
  lines.push("");
  lines.push("      // Reject all pending requests");
  lines.push("      for (const [id, pending] of pendingRequests) {");
  lines.push("        pending.reject(new Error('IPC connection closed'));");
  lines.push("        pendingRequests.delete(id);");
  lines.push("      }");
  lines.push("    });");
  lines.push("  });");
  lines.push("");
  lines.push("  return connectionPromise;");
  lines.push("}");
  lines.push("");
  lines.push("/**");
  lines.push(" * Call a tool via IPC");
  lines.push(" *");
  lines.push(" * @param toolName The name of the tool to call");
  lines.push(" * @param input The input parameters for the tool");
  lines.push(" * @returns Promise resolving to the tool result");
  lines.push(" */");
  lines.push("export async function callTool(toolName: string, input: unknown): Promise<string> {");
  lines.push("  await ensureConnection();");
  lines.push("");
  lines.push("  const id = String(++requestId);");
  lines.push("");
  lines.push("  const request: IPCRequest = {");
  lines.push("    id,");
  lines.push("    method: 'tool_call',");
  lines.push("    params: {");
  lines.push("      tool_name: toolName,");
  lines.push("      input,");
  lines.push("    },");
  lines.push("  };");
  lines.push("");
  lines.push("  return new Promise((resolve, reject) => {");
  lines.push("    // Timeout after 5 minutes; cleared on settle so a finished call");
  lines.push("    // never leaves a timer holding the process open.");
  lines.push("    const timer = setTimeout(() => {");
  lines.push("      if (pendingRequests.has(id)) {");
  lines.push("        pendingRequests.delete(id);");
  lines.push("        updateSocketRef();");
  lines.push("        reject(new Error(\"Tool call '\" + toolName + \"' timed out\"));");
  lines.push("      }");
  lines.push("    }, 300000);");
  lines.push("    timer.unref();");
  lines.push("");
  lines.push("    pendingRequests.set(id, {");
  lines.push("      resolve: (value: any) => {");
  lines.push("        clearTimeout(timer);");
  lines.push("        resolve(value);");
  lines.push("      },");
  lines.push("      reject: (error: Error) => {");
  lines.push("        clearTimeout(timer);");
  lines.push("        reject(error);");
  lines.push("      },");
  lines.push("    });");
  lines.push("    updateSocketRef();");
  lines.push("");
  lines.push('    const message = JSON.stringify(request) + "\\n";');
  lines.push("    client!.write(message, (err: Error | undefined) => {");
  lines.push("      if (err) {");
  lines.push("        const pending = pendingRequests.get(id);");
  lines.push("        if (pending) {");
  lines.push("          pendingRequests.delete(id);");
  lines.push("          updateSocketRef();");
  lines.push("          pending.reject(err);");
  lines.push("        }");
  lines.push("      }");
  lines.push("    });");
  lines.push("  });");
  lines.push("}");
  lines.push("");
  lines.push("/**");
  lines.push(" * Close the IPC connection");
  lines.push(" */");
  lines.push("export function closeConnection(): void {");
  lines.push("  if (client) {");
  lines.push("    client.end();");
  lines.push("    client = null;");
  lines.push("  }");
  lines.push("  connectionPromise = null;");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- outputDir is a host-derived workspace path; every derived path is checked by assertPathContained.
  const resolvedOutputDir = resolve(outputDir);

  /**
   * Validate that a resolved path is contained within the output directory.
   * Throws if the path escapes the output directory boundary.
   */
  function assertPathContained(filePath: string): void {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- this IS the containment guard; the relative check below rejects escapes.
    const resolvedPath = resolve(filePath);
    // Cross-platform containment via path.relative: the previous
    // `startsWith(resolvedOutputDir + "/")` rejected every Windows path (which
    // uses `\`) and mishandled sibling-prefix directories.
    const rel = relative(resolvedOutputDir, resolvedPath);
    if (rel !== "" && (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))) {
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- validated by assertPathContained immediately below.
  const runtimePath = join(resolvedOutputDir, "_runtime.ts");
  assertPathContained(runtimePath);
  const runtimeContent = generateRuntimeModule(ipcSocketPath);
  writeFileSync(runtimePath, runtimeContent);

  // Generate category directories and tool modules
  for (const [category, categoryTools] of categories) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- validated by assertPathContained immediately below.
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
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- validated by assertPathContained immediately below.
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
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- validated by assertPathContained immediately below.
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- validated by assertPathContained immediately below.
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
export {
  toFunctionName,
  toInterfaceName,
  zodToTypeScript,
  getToolCategory,
  escapeJsDocText,
};
