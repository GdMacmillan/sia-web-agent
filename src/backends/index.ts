/**
 * Backends for pluggable file storage.
 *
 * Backends provide a uniform interface for file operations while allowing
 * different storage mechanisms (state, store, filesystem, database, etc.).
 */

export type {
  BackendProtocol,
  BackendFactory,
  SandboxBackendProtocolV2,
  FileData,
  FileDataV1,
  FileDataV2,
  FileInfo,
  GrepMatch,
  LsResult,
  GlobResult,
  GrepResult,
  ReadResult,
  ReadRawResult,
  WriteResult,
  EditResult,
  DeleteResult,
  ExecuteResponse,
  FileOperationError,
  FileDownloadResponse,
  FileUploadResponse,
  StateAndStore,
} from "./protocol.js";
export { isFileDataV1, isSandboxBackend } from "./protocol.js";

export { StateBackend } from "./state.js";
export { StoreBackend } from "./store.js";
export { FilesystemBackend } from "./filesystem.js";
export { CompositeBackend } from "./composite.js";
export { RemoteBackend } from "./remote.js";
export { BaseSandbox } from "./sandbox.js";
export type { RemoteBackendConfig } from "./remote.js";
export type { RemoteNodeInfo, NodeDiscoveryFn } from "./node-registry.js";

// Re-export utils for convenience
export * from "./utils.js";
