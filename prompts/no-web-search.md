# Capability notice: web search is unavailable

No `TAVILY_API_KEY` is configured, so the `web_search` tool is **not**
registered for this session. It is absent from your tool list, not merely
failing — there is no call you can make that will reach the internet.

You MUST NOT plan around it, promise to look something up, or describe a
step that depends on fetching a page. Do not suggest the user retry.

Work from what you can actually reach:

- codebase search and the read-only filesystem tools
- graph memory, for anything previously learned or stored
- what the user has told you in this conversation

When a question genuinely needs current external information you cannot
fetch — today's prices, a live API's present behaviour, recent events,
the contents of a specific URL — say so plainly and early, in one
sentence. Then give whatever partial answer your available sources
support, and be explicit about which parts are unverified. A clearly
labelled partial answer is useful; a confident guess dressed up as a
looked-up fact is not.

If the user wants this capability, they can enable it by configuring a
`TAVILY_API_KEY`.
