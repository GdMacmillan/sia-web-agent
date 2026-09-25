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
  CURRENT_FILE_PATTERN,
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
  MIDDLEWARE_ONLY_TOOL_NAMES,
  MIDDLEWARE_TOOL_NAMES,
  SEED_COMPONENTS_DIRNAME,
  prepareComponentAssembly,
  resolveComponentRoots,
  type ComponentAssembly,
  type PrepareComponentAssemblyOptions,
} from "./assemble.js";
export {
  VERSION_BUMPS,
  bumpVersion,
  describeComponent,
  isVersionBump,
  listComponentVersions,
  planComponentVersion,
  readComponentVersion,
  type ComponentDescription,
  type DescribeComponentInput,
  type DescribeComponentResult,
  type PlanComponentVersionInput,
  type PlanComponentVersionResult,
  type PlannedComponentVersion,
  type ReadComponentVersionInput,
  type ReadComponentVersionResult,
  type VersionBump,
} from "./authoring.js";
export {
  DEFAULT_CONTRACT_TIMEOUT_MS,
  runComponentContract,
  type ContractResult,
  type LoadedFile,
  type RunContractOptions,
} from "./contract.js";
export {
  LINEAGE_ENTITY_TYPE,
  OUTCOMES,
  SUPERSEDES,
  buildLineageEntity,
  buildParentEntity,
  decideReconcile,
  lineageTitle,
  outcomeFromHostResult,
  parseLineageRef,
  settlePayload,
  type HostComponentView,
  type LineageEntityInput,
  type LineageOutcome,
  type PendingVersion,
  type ReconcileDecision,
  type SettledOutcome,
  type TrackedPendingVersion,
  type Verdict,
} from "./lineage.js";
export { parseHostStatus, readHostComponents } from "./lineage-host.js";
export {
  ensureParentEntity,
  findLineageEntity,
  markLineageAnnounced,
  settleLineageEntity,
  storeLineageEntity,
} from "./lineage-store.js";
export {
  _setLineageReconcilerForTests,
  createLineageReconciler,
  discoverProducedVersions,
  getLineageReconciler,
  type HostOutcomeFrame,
  type HostOutcomeResult,
  type LineageReconciler,
  type LineageReconcilerOptions,
  type TrackedVersion,
} from "./lineage-reconcile.js";
