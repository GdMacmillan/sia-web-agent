/**
 * Backend Configuration
 *
 * Sets up the default filesystem backend for the deep agent.
 * The agent operates on the self-improving-agent project root,
 * allowing it to read and modify its own codebase.
 *
 * When DATABASE_URL is set and remote nodes are online, wraps the
 * FilesystemBackend in a CompositeBackend that routes /remote/{nodeId}/
 * paths to RemoteBackend instances for cross-filesystem content sharing.
 */

import { FilesystemBackend } from "./backends/index.js";
import { CompositeBackend } from "./backends/index.js";
import { RemoteBackend } from "./backends/index.js";
import type { BackendFactory } from "./backends/index.js";
import type { RemoteNodeInfo, NodeDiscoveryFn } from "./backends/index.js";
import { getProjectRoot as getProjectRootFromUtils } from "./utils/path-utils.js";

/**
 * Determine the project root directory.
 *
 * Uses the robust path utilities module which tries multiple strategies:
 * 1. Locate from module position (import.meta.url)
 * 2. Find marker files (langgraph.json, CLAUDE.md, package.json)
 * 3. Walk up directory tree looking for "self-improving-agent"
 * 4. Fall back to process.cwd()
 *
 * @returns Absolute path to the project root
 */
export function getProjectRoot(): string {
  return getProjectRootFromUtils();
}

/** Cached remote nodes to avoid re-querying on every tool call */
let cachedRemoteNodes: RemoteNodeInfo[] | null = null;

/**
 * Initialize remote node discovery.
 * Call this once at server startup before creating backends.
 *
 * @param discover - Function that returns online remote nodes
 * @param localNodeId - This node's ID (excluded from remote list)
 */
export async function initializeRemoteNodes(
  discover: NodeDiscoveryFn,
  localNodeId?: string,
): Promise<void> {
  try {
    cachedRemoteNodes = await discover(localNodeId);
    if (cachedRemoteNodes.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[backend-config] Discovered ${cachedRemoteNodes.length} remote node(s): ${cachedRemoteNodes.map((n) => n.nodeId).join(", ")}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[backend-config] Failed to query remote nodes:", err);
    cachedRemoteNodes = null;
  }
}

/**
 * Refresh the cached remote nodes list.
 * Can be called periodically or on-demand to pick up new nodes.
 */
export async function refreshRemoteNodes(
  discover: NodeDiscoveryFn,
  localNodeId?: string,
): Promise<void> {
  await initializeRemoteNodes(discover, localNodeId);
}

/**
 * Create the default backend factory for the deep agent.
 *
 * Uses FilesystemBackend with actual filesystem access (not sandboxed).
 * If remote nodes were discovered via initializeRemoteNodes(), wraps
 * in a CompositeBackend with /remote/{nodeId}/ routes.
 *
 * IMPORTANT: getProjectRoot() is called lazily inside the returned function,
 * not at factory creation time. This ensures that when running in self-improve
 * mode (worktrees), the SIA_PROJECT_ROOT environment variable is properly
 * read at tool execution time rather than at module load time.
 *
 * @returns BackendFactory that creates a FilesystemBackend or CompositeBackend
 */
export function createDefaultBackendFactory(): BackendFactory {
  return () => {
    // Evaluate project root lazily at tool execution time
    // This is critical for self-improve mode where SIA_PROJECT_ROOT
    // points to the worktree directory
    const projectRoot = getProjectRoot();
    const localBackend = new FilesystemBackend({
      rootDir: projectRoot,
      virtualMode: false, // Real filesystem access - agent makes actual code changes
    });

    // If remote nodes are available, wrap in CompositeBackend
    if (cachedRemoteNodes && cachedRemoteNodes.length > 0) {
      const routes: Record<string, RemoteBackend> = {};
      for (const node of cachedRemoteNodes) {
        const baseUrl = `http://${node.networkEndpoint}:${node.daemonPort}`;
        routes[`/remote/${node.nodeId}/`] = new RemoteBackend({
          baseUrl,
          nodeId: node.nodeId,
          leaderSync: { projectRoot },
        });
      }
      return new CompositeBackend(localBackend, routes);
    }

    return localBackend;
  };
}

/**
 * Get remote node info for system prompt generation.
 * Returns null if no remote nodes are configured.
 */
export function getRemoteNodesInfo(): string | null {
  if (!cachedRemoteNodes || cachedRemoteNodes.length === 0) return null;

  const nodeList = cachedRemoteNodes
    .map((n) => `  - /remote/${n.nodeId}/ (${n.name || n.nodeId})`)
    .join("\n");

  return `Remote nodes available for cross-filesystem file access. Use paths like
/remote/{nodeId}/path/to/file to access files on other machines. Use \`ls /remote/\` to discover
available nodes. Remote writes are automatically synced to the leader.

Available remote nodes:\n${nodeList}`;
}

/**
 * The default backend factory for deep agents.
 *
 * Exported at module level so it can be used as a default in createDeepAgent.
 * The factory creates a FilesystemBackend with the project root.
 */
export const defaultBackendFactory = createDefaultBackendFactory();
