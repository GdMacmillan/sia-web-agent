# @sia-web/agent

The SIA agent runtime — a [LangGraph](https://langchain-ai.github.io/langgraphjs/)
deep-agent with prompts, skills, and tool middleware. Extracted from the
`sia-web` project for standalone use and open-source contribution.

## What is it

A multi-agent system built on the LangGraph framework. The main agent
orchestrates lazily-loaded specialists (`plan`, `research`, `answer`,
`general-purpose`) and consumes a small host contract (env vars at spawn time
plus an optional loopback HTTP endpoint for usage events). The agent has no
runtime dependency on the rest of `sia-web` — it can run anywhere a LangGraph
agent can run.

## Quick start

```bash
yarn install
yarn build
yarn test
```

## Running locally with an LLM API key

```bash
cp .env.example .env
# Edit .env: set OPENROUTER_API_KEY and at least the model tiers you want.

yarn dev        # tsx watch src/index.ts
# — or —
yarn build && node dist/index.js
```

The agent's graph is exported from `src/graph.ts` (the entry referenced by
`langgraph.json`). Running with `langgraph dev` (or the LangGraph CLI of your
choice) will pick it up automatically.

## Layout

- `src/`     — agent source (graph, middleware, tools, sub-agents)
- `prompts/` — system prompts for manager / planner / researcher / answer
- `skills/`  — extended capabilities loaded on demand via the `load_skill` tool
- `tests/`   — unit + integration + debugging suites

## License

MIT. See [LICENSE](LICENSE).
