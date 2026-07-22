/**
 * Local copy of the subagent response-format config key.
 *
 * Upstream `@langchain/quickjs` imports this from the `deepagents`
 * package (`libs/deepagents/src/middleware/subagents.ts`). This fork
 * vendors the code interpreter rather than depending on the published
 * `@langchain/quickjs` package, so we keep a local copy of the single
 * constant the bridge needs instead of pulling in `deepagents`.
 *
 * The value MUST stay byte-for-byte identical to upstream so that if
 * the fork's subagent middleware later grows the ability to recompile a
 * subagent with a structured response format (as upstream's does), it
 * reads the same key the bridge writes. Today the fork's task tool does
 * NOT consume this key, so a `responseSchema` passed to `task()` inside
 * an eval is validated but otherwise a no-op. Keep the two in lockstep
 * when that changes.
 */
export const SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY =
  "__deepagents_subagent_response_format";
