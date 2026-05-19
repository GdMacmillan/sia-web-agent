/**
 * Node discovery types for remote backend configuration.
 *
 * The concrete NodeRegistry implementation (e.g. PostgreSQL-backed) is supplied
 * by the host runtime. This file defines the interface contract so the agent
 * has no dependency on any specific host or chat-room database.
 */

export interface RemoteNodeInfo {
  nodeId: string;
  networkEndpoint: string;
  daemonPort: number;
  name?: string | null;
}

export type NodeDiscoveryFn = (
  excludeNodeId?: string,
) => Promise<RemoteNodeInfo[]>;
