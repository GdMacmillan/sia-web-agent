/**
 * Host context wrapper.
 *
 * Context the harness supplies to the model, as opposed to text a person
 * wrote, is delivered inside a single tagged envelope so the model can tell
 * the two apart and so the system prompt can stay byte-stable (and cacheable)
 * while this context varies. Every emission goes through `wrapHostContext` —
 * the tag name and attribute shape live here and nowhere else.
 */

/**
 * Where a piece of host context came from.
 *
 * - `session`: fixed for the life of the process (the skills list).
 * - `date`: the current date, recomputed on every model call.
 * - `conversation`: a context message that arrived inside the conversation
 *   history (a system-role message written into state by the host).
 */
export type HostContextSource = "session" | "date" | "conversation";

/** The tag that delimits host context. */
export const HOST_CONTEXT_TAG = "host-context";

/**
 * Wrap a body of host context in the tagged envelope.
 *
 * @param source - What produced the context
 * @param body - The context itself, verbatim
 * @returns `<host-context source="…">\n…\n</host-context>`
 */
export function wrapHostContext(
  source: HostContextSource,
  body: string,
): string {
  return `<${HOST_CONTEXT_TAG} source="${source}">\n${body}\n</${HOST_CONTEXT_TAG}>`;
}
