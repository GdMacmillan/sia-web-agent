/**
 * Utilities Module
 *
 * Exports common utilities used throughout the agent package.
 */

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
} from "./path-utils.js";

export { logger } from "./logger.js";
