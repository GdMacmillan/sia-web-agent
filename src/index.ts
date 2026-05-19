export { createDeepAgent } from "./agent.js";
export {
  createDeepAgentWithDefaults,
  createDeepAgentComponents,
  createStandardTools,
  createStandardModel,
} from "./deep-agent-setup.js";
export {
  getProjectRoot,
  getAgentPackageRoot,
  resolveProjectPath,
  getRelativeProjectPath,
  findProjectRootByMarker,
  findProjectRootFromModule,
  findProjectRootByName,
  clearProjectRootCache,
  getPathDiagnostics,
} from "./utils/path-utils.js";
export type { SubAgent, CompiledSubAgent } from "./middleware/index.js";
export type { CreateDeepAgentParams } from "./agent.js";
export type {
  DeepAgentConfig,
  DeepAgentComponents,
} from "./deep-agent-setup.js";
