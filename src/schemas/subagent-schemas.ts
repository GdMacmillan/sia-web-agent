import { z } from "zod";

// =============================================================================
// Research Agent Schemas
// =============================================================================

/**
 * Input schema for the Research sub-agent.
 * Controls the scope, depth, and focus of codebase investigation.
 */
export const ResearchInputSchema = z.object({
  /** Context about what to research */
  description: z.string().describe("Research task context and objectives"),

  /** Controls scope of investigation */
  depth: z
    .enum(["shallow", "medium", "deep"])
    .default("medium")
    .describe(
      "shallow: 3-5 key files, surface analysis. medium: 10-15 files, trace one dependency level. deep: comprehensive analysis, full dependency chains",
    ),

  /** Type of research to perform */
  taskType: z
    .enum(["architecture", "dependency", "logic", "pattern", "comparison"])
    .describe(
      "architecture: system structure/patterns. dependency: trace relationships. logic: understand code flow. pattern: find recurring approaches. comparison: compare implementations",
    ),

  /** Specific paths or patterns to prioritize */
  focusAreas: z
    .array(z.string())
    .optional()
    .describe("Specific file paths, directories, or patterns to focus on"),
});

export type ResearchInput = z.infer<typeof ResearchInputSchema>;

/**
 * Component schema for codebase structure findings.
 */
const CodebaseComponentSchema = z.object({
  /** Component name */
  name: z.string(),
  /** File path where component is defined */
  path: z.string(),
  /** Brief description of component's purpose */
  purpose: z.string(),
});

/**
 * Dependency relationship schema.
 */
const DependencySchema = z.object({
  /** Source of the dependency */
  from: z.string(),
  /** Target of the dependency */
  to: z.string(),
  /** Type of dependency (import, inheritance, composition, etc.) */
  type: z.string(),
});

/**
 * Individual finding with evidence.
 */
const FindingSchema = z.object({
  /** Brief title for the finding */
  title: z.string(),
  /** Detailed description of what was found */
  description: z.string(),
  /** Supporting evidence (code snippet, observation, etc.) */
  evidence: z.string(),
  /** File path where finding was made */
  filePath: z.string().optional(),
  /** Line number in the file */
  lineNumber: z.number().optional(),
});

/**
 * Issue discovered during research.
 */
const IssueSchema = z.object({
  /** Issue severity */
  severity: z.enum(["low", "medium", "high"]),
  /** Description of the issue */
  description: z.string(),
  /** Location in codebase */
  location: z.string().optional(),
});

/**
 * Output schema for the Research sub-agent.
 * Structured report of investigation findings.
 */
export const ResearchOutputSchema = z.object({
  /** Executive summary (2-3 sentences) */
  summary: z.string().describe("Executive summary of research findings"),

  /** Structural findings from the codebase */
  codebaseStructure: z.object({
    /** Relevant file paths discovered */
    relevantPaths: z.array(z.string()),
    /** Key components identified */
    keyComponents: z.array(CodebaseComponentSchema),
    /** Dependencies traced */
    dependencies: z.array(DependencySchema).optional(),
  }),

  /** Actionable recommendations */
  recommendations: z
    .array(z.string())
    .describe("Actionable recommendations based on findings"),

  /** Detailed findings with evidence */
  findings: z
    .array(FindingSchema)
    .describe("Detailed findings with supporting evidence"),

  /** Issues discovered during research */
  issues: z.array(IssueSchema).optional().describe("Issues or problems found"),
});

export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// =============================================================================
// Plan Agent Schemas
// =============================================================================

/**
 * Input schema for the Plan sub-agent.
 * Defines requirements and constraints for implementation planning.
 */
export const PlanInputSchema = z.object({
  /** Context about the planning task */
  description: z.string().describe("Planning task context and background"),

  /** What needs to be accomplished */
  requirements: z
    .string()
    .describe("Clear statement of what needs to be accomplished"),

  /** Limitations to consider */
  constraints: z
    .array(z.string())
    .optional()
    .describe("Constraints or limitations to consider during planning"),

  /** Expected files to modify */
  targetFiles: z
    .array(z.string())
    .optional()
    .describe("Files expected to be modified or created"),
});

export type PlanInput = z.infer<typeof PlanInputSchema>;

/**
 * File change specification for a plan step.
 */
const FileChangeSchema = z.object({
  /** File path */
  path: z.string(),
  /** Type of change */
  changeType: z.enum(["create", "modify", "delete"]),
  /** Description of the change */
  description: z.string(),
});

/**
 * Individual implementation step.
 */
const StepSchema = z.object({
  /** Unique identifier for the step */
  id: z.string(),
  /** What needs to be done */
  description: z.string(),
  /** Success criteria for this step */
  expectedOutcome: z.string(),
  /** Files that will be changed in this step */
  fileChanges: z.array(FileChangeSchema).optional(),
  /** Step IDs this depends on */
  dependencies: z.array(z.string()).optional(),
});

/**
 * Output schema for the Plan sub-agent.
 * Structured implementation plan with steps, risks, and assumptions.
 */
export const PlanOutputSchema = z.object({
  /** High-level plan summary (1-2 sentences) */
  summary: z.string().describe("High-level summary of the implementation plan"),

  /** Ordered implementation steps */
  steps: z
    .array(StepSchema)
    .describe("Ordered implementation steps with dependencies"),

  /** Potential risks or challenges */
  risks: z.array(z.string()).describe("Potential risks or challenges"),

  /** Assumptions made during planning */
  assumptions: z.array(z.string()).describe("Assumptions made in this plan"),
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// =============================================================================
// Task Tool Input Schema (Discriminated Union)
// =============================================================================

/**
 * Research task input with agent type discriminator.
 */
export const ResearchTaskSchema = ResearchInputSchema.extend({
  subagent_type: z.literal("research"),
});

/**
 * Plan task input with agent type discriminator.
 */
export const PlanTaskSchema = PlanInputSchema.extend({
  subagent_type: z.literal("plan"),
});

/**
 * General-purpose task input (backward compatibility).
 */
export const GeneralPurposeTaskSchema = z.object({
  subagent_type: z.literal("general-purpose"),
  description: z
    .string()
    .describe("Task description for general-purpose agent"),
});

/**
 * Discriminated union for task tool input.
 * Routes to appropriate sub-agent based on subagent_type.
 */
export const TaskInputSchema = z.discriminatedUnion("subagent_type", [
  ResearchTaskSchema,
  PlanTaskSchema,
  GeneralPurposeTaskSchema,
]);

export type TaskInput = z.infer<typeof TaskInputSchema>;

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Sub-agent type names.
 */
export type SubAgentType = "research" | "plan" | "general-purpose";

/**
 * Map of output schemas by sub-agent type.
 */
export const OutputSchemaMap = {
  research: ResearchOutputSchema,
  plan: PlanOutputSchema,
  "general-purpose": z.unknown(), // No structured output for general-purpose
} as const;
