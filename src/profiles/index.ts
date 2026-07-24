/**
 * Harness profiles — behavior-shaping configuration units ("proto-genomes").
 */
export {
  createHarnessProfile,
  parseHarnessProfileConfig,
  serializeProfile,
  harnessProfileConfigSchema,
  EMPTY_HARNESS_PROFILE,
  REQUIRED_MIDDLEWARE_NAMES,
  type HarnessProfile,
  type HarnessProfileOptions,
  type HarnessProfileConfigData,
} from "./harness.js";
export { resolveHarnessProfile, builtinProfileNames } from "./builtins.js";
