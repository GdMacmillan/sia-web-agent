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
