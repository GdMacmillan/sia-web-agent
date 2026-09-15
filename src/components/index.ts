/**
 * Components — versioned units of agent code loaded from disk with
 * dependency-injected factories. See `docs/COMPONENTS.md`.
 */

export {
  COMPONENT_KINDS,
  COMPONENT_NAME_PATTERN,
  ComponentManifestSchema,
  parseComponentManifest,
  type ComponentKind,
  type ComponentManifest,
  type ParseManifestContext,
  type ParseManifestResult,
} from "./manifest.js";
export {
  CURRENT_LINK,
  MANIFEST_FILE,
  MAX_MANIFEST_BYTES,
  VERSIONS_DIR,
  describeComponentVersion,
  discoverComponents,
  type DiscoveredComponent,
  type DiscoveryResult,
  type ShadowedComponent,
  type SkippedComponent,
} from "./discovery.js";
export {
  SDK_VERSION,
  buildComponentDeps,
  buildInternals,
  type ComponentConfig,
  type ComponentContract,
  type ComponentDeps,
  type ComponentEntry,
  type ComponentInternals,
  type ComponentLogger,
  type ContractDeps,
  type ContractInvoke,
  type InvokeOptions,
} from "./sdk.js";
export {
  defaultImportModule,
  isMiddlewareLike,
  isToolLike,
  loadComponents,
  type ImportModule,
  type LoadComponentsOptions,
  type LoadComponentsResult,
  type LoadedComponent,
  type LoadedMiddleware,
} from "./loader.js";
export { REPLACES_TAG, readReplaces, tagReplaces } from "./replaces-tag.js";
export {
  COMPONENTS_MIDDLEWARE_NAME,
  _resetComponentsForTests,
  createComponentsMiddleware,
  getActiveComponents,
  getActiveToolPool,
  refreshActiveManifests,
  setActiveComponents,
  setActiveToolPool,
  type ActiveComponent,
  type ActiveComponentsState,
} from "./registry.js";
export {
  MIDDLEWARE_TOOL_NAMES,
  SEED_COMPONENTS_DIRNAME,
  prepareComponentAssembly,
  resolveComponentRoots,
  type ComponentAssembly,
  type PrepareComponentAssemblyOptions,
} from "./assemble.js";
export {
  DEFAULT_CONTRACT_TIMEOUT_MS,
  runComponentContract,
  type ContractResult,
  type RunContractOptions,
} from "./contract.js";
