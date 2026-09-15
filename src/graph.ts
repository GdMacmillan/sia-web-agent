/**
 * LangGraph Server Entry Point
 *
 * This file exports the agent graph for the LangGraph CLI server.
 * The graph is registered in langgraph.json and accessible via the REST API.
 */

import { createDeepAgentWithDefaults } from "./deep-agent-setup.js";
import { getProjectRoot } from "./backend-config.js";

// Create the agent graph
const projectRoot = getProjectRoot();
const agent = await createDeepAgentWithDefaults({ projectRoot });

// Export the compiled graph for LangGraph server
// Note: recursion_limit (1000) is configured at runtime via the API config parameter
// in evaluation/agent_client.py. See LangGraph API reference:
// https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html

export const graph: any = agent.graph;

// The in-process contract runner for on-disk components (docs/COMPONENTS.md
// §6). A host that only knows about `graph` never sees it; one that does can
// gate a component version on it.
export { runComponentContract } from "./components/contract.js";
