/**
 * Test-only adapters that unwrap the backend protocol-v2 Result types back to
 * the legacy return shapes, so existing backend tests can assert on plain
 * values while still exercising the real (renamed) v2 methods:
 *
 *   ls()      -> LsResult      unwrapped to FileInfo[]
 *   glob()    -> GlobResult    unwrapped to FileInfo[]
 *   grep()    -> GrepResult    unwrapped to GrepMatch[] | string (error)
 *   read()    -> ReadResult    unwrapped to string ("Error: ..." on error)
 *   readRaw() -> ReadRawResult unwrapped to FileDataV1 (throws on error)
 *
 * New-shape assertions (delete, multimodal, error objects) are tested directly
 * against the Result types elsewhere — these helpers only keep the large body
 * of pre-existing v1-shaped tests meaningful without rewriting every assertion.
 *
 * Not a *.test.ts file, so jest does not execute it as a suite.
 */
import type {
  BackendProtocol,
  FileDataV1,
  FileInfo,
  GrepMatch,
} from "../../src/backends/protocol.js";

export async function lsFiles(
  backend: BackendProtocol,
  path: string,
): Promise<FileInfo[]> {
  const result = await backend.ls(path);
  return result.files ?? [];
}

export async function globFiles(
  backend: BackendProtocol,
  pattern: string,
  path?: string,
): Promise<FileInfo[]> {
  const result = await backend.glob(pattern, path);
  return result.files ?? [];
}

export async function grepResult(
  backend: BackendProtocol,
  pattern: string,
  path?: string | null,
  glob?: string | null,
): Promise<GrepMatch[] | string> {
  const result = await backend.grep(pattern, path, glob);
  if (result.error !== undefined) return result.error;
  return result.matches ?? [];
}

export async function readStr(
  backend: BackendProtocol,
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const result = await backend.read(filePath, offset, limit);
  if (result.error !== undefined) return `Error: ${result.error}`;
  return typeof result.content === "string" ? result.content : "";
}

export async function readRawData(
  backend: BackendProtocol,
  filePath: string,
): Promise<FileDataV1> {
  const result = await backend.readRaw(filePath);
  if (result.error !== undefined || !result.data) {
    throw new Error(result.error ?? `File '${filePath}' not found`);
  }
  // The state/store/filesystem/remote backends all persist v1 (line-array)
  // FileData, which is what these tests assert on.
  return result.data as FileDataV1;
}
