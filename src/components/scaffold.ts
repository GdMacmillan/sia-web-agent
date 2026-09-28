/**
 * Scaffold for the first version of a brand-new component: the manifest,
 * an entry that contributes one runnable tool, and a contract that calls
 * it. See `docs/COMPONENTS.md` §Authoring a new component.
 *
 * The stub is deliberately trivial and deliberately passing: the tool
 * echoes its input and the contract checks the echo, so the author starts
 * from a version whose contract runs green — the analogue of copying the
 * current version when iterating an existing component — and changes the
 * entry and the contract together from there.
 *
 * The generated sources import nothing: a version under the host-managed
 * root has no source tree beside it, so everything arrives on `deps`.
 */

import { SDK_VERSION } from "./sdk.js";

/** Every new component starts here. */
export const NEW_COMPONENT_VERSION = "0.1.0";

/** What a tool may be called: the model-boundary rule for tool names. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The tool name a component name suggests: `parse-time-expression` → `parse_time_expression`. */
export function defaultToolName(componentName: string): string {
  return componentName.replace(/-/g, "_");
}

export interface NewComponentManifestInput {
  name: string;
  intent: string;
  need: string;
  producedBy: string;
}

/**
 * The manifest of a first version: `kind: tools`, depth 0, the SDK range
 * this source tree was built against, and a lineage with a need and a
 * producer but no parent — a first version is the root of its lineage.
 */
export function newComponentManifest(input: NewComponentManifestInput): Record<string, unknown> {
  return {
    name: input.name,
    version: NEW_COMPONENT_VERSION,
    kind: "tools",
    intent: input.intent,
    sdk: `^${SDK_VERSION}`,
    depth: 0,
    lineage: {
      need: input.need,
      producedBy: input.producedBy,
    },
  };
}

/** Source of `entry.ts`: one tool named `toolName` that echoes its input. */
export function stubEntrySource(toolName: string, description: string): string {
  return `/**
 * ${toolName} — first version, scaffolded from the need in the manifest.
 *
 * The default export receives the component SDK (\`deps\`) and returns the
 * tools this component contributes. This stub echoes its input so the
 * contract passes before any real work is done: replace the body with what
 * the need asks for, widen the schema to the inputs the tool takes, and
 * make the contract prove the new behaviour.
 *
 * Imports nothing at runtime; everything arrives on \`deps\`.
 */

type Deps = {
  tool: (fn: (input: any, config?: any) => Promise<string> | string, options: any) => unknown;
  z: any;
  logger: { info: (message: string, meta?: Record<string, unknown>) => void };
};

export default function (deps: Deps) {
  const ${toolName} = deps.tool(
    async (input: { text: string }) => {
      return JSON.stringify({ echo: input.text });
    },
    {
      name: ${JSON.stringify(toolName)},
      description: ${JSON.stringify(description)},
      schema: deps.z.object({
        text: deps.z.string().describe("The input to handle."),
      }),
    },
  );
  return [${toolName}];
}
`;
}

/** Source of `contract.ts`: invokes `toolName` through the SDK and checks the echo. */
export function stubContractSource(toolName: string): string {
  return `/**
 * Contract for ${toolName}: black-box cases through the tool itself, via
 * \`deps.invoke\`. Any throw fails the contract; returning passes it. Each
 * case should fail without the behaviour it checks — a version proves
 * itself. Replace the echo case as the tool grows.
 *
 * Imports nothing at runtime.
 */

type ContractDeps = {
  invoke: (toolName: string, args: unknown) => Promise<string>;
  component: unknown;
};

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export default async function (deps: ContractDeps): Promise<void> {
  const tools = deps.component as Array<{ name?: string }>;
  check(
    Array.isArray(tools) && tools.some((t) => t?.name === ${JSON.stringify(toolName)}),
    ${JSON.stringify(`entry did not return a tool named ${toolName}`)},
  );

  const result = await deps.invoke(${JSON.stringify(toolName)}, { text: "ping" });
  check(
    typeof result === "string" && result.includes("ping"),
    ${JSON.stringify(`${toolName} did not echo its input: `)} + JSON.stringify(result),
  );
}
`;
}
