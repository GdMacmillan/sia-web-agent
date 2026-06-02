/**
 * Global teardown for integration tests.
 *
 * Safety net that runs after all integration tests complete.
 * Calls POST /admin/bulk-delete to sweep any test entities that
 * individual afterAll hooks may have missed.
 *
 * Silently skips if graph-memory server isn't running.
 */

export default async function globalTeardown() {
  const GRAPH_MEMORY_API =
    process.env.TEST_GRAPH_MEMORY_URL || "http://localhost:8080";

  try {
    const response = await fetch(`${GRAPH_MEMORY_API}/admin/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "test-agent" }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      const deleted = data.data?.deleted ?? 0;
      if (deleted > 0) {
        console.log(
          `[global-teardown] Cleaned up ${deleted} leftover test entities`,
        );
      }
    }
  } catch {
    // Graph-memory server not running — nothing to clean up
  }
}
