# Agent Configuration System

Centralized, type-safe configuration with fail-fast validation. All environment variables are parsed in a single loader and exposed as typed properties.

## Files

| File                                | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| **`schema.ts`**                     | TypeScript interfaces for the entire config                       |
| **`loader.ts`**                     | Centralized env var loader — the ONLY place reading `process.env` |
| **`validate.ts`**                   | Startup validation with helpful error messages                    |
| **`index.ts`**                      | Public API — import everything from here                          |
| **`llm-providers.ts`**              | Provider preset definitions (internal, used by loader)            |
| **`model-config.ts`**               | Per-agent model factory functions (backward compat)               |
| **`knowledge-formation-config.ts`** | Knowledge extraction defaults and types                           |
| **`agent-tools.ts`**                | Agent-specific tool sets and permissions                          |

## Quick Start

```typescript
import {
  getConfig,
  validateConfig,
  logValidationResult,
} from "./config/index.js";

// At startup
const config = getConfig();
const result = validateConfig(config);
logValidationResult(result);

// Access typed config
const model = config.llm.model;
const triggerTokens = config.middleware.summarization.triggerTokens;
const tavilyKey = config.services.tavily.apiKey;
```

## Supported Providers

| Provider     | Env Prefix    | Default Base URL               | Requires Key | Default Model        |
| ------------ | ------------- | ------------------------------ | ------------ | -------------------- |
| `openrouter` | `OPENROUTER_` | `https://openrouter.ai/api/v1` | YES          | `openai/gpt-4o-mini` |
| `openai`     | `OPENAI_`     | `https://api.openai.com/v1`    | YES          | `gpt-4o-mini`        |
| `vllm`       | `VLLM_`       | `http://localhost:8000/v1`     | NO           | (none)               |
| `ollama`     | `OLLAMA_`     | `http://localhost:11434/v1`    | NO           | (none)               |
| `lmstudio`   | `LMSTUDIO_`   | `http://localhost:1234/v1`     | NO           | (none)               |
| `custom`     | `LLM_`        | (must set `LLM_BASE_URL`)      | NO           | (none)               |

## Model Tier System (NEW)

Instead of mapping models to agent roles, models are mapped to **capability tiers**. Agents then declare which tier they need.

### Tier Environment Variables

| Variable                        | Purpose                            | Fallback         |
| ------------------------------- | ---------------------------------- | ---------------- |
| `{PREFIX}_SMALL_FAST_MODEL`     | Quick, cheap model for routing     | `{PREFIX}_MODEL` |
| `{PREFIX}_MIDTIER_MODEL`        | Balanced cost/capability           | `{PREFIX}_MODEL` |
| `{PREFIX}_HEAVY_THINKING_MODEL` | Most capable for complex reasoning | `{PREFIX}_MODEL` |

### Default Agent-to-Tier Mapping

| Agent        | Default Tier    | Rationale                           |
| ------------ | --------------- | ----------------------------------- |
| orchestrator | `midtier`       | Balanced routing and task execution |
| planner      | `heavyThinking` | Complex reasoning, planning         |
| researcher   | `midtier`       | Balanced analysis                   |
| memory       | `smallFast`     | Simple extraction                   |
| answer       | `midtier`       | Balanced synthesis                  |
| toolUse      | `midtier`       | Tool calling accuracy               |

### Example: Tier-Based Setup

```bash
OPENROUTER_API_KEY=sk-or-v1-yyy
OPENROUTER_SMALL_FAST_MODEL=google/gemini-3-flash-preview
OPENROUTER_MIDTIER_MODEL=openai/gpt-5.1-codex-mini
OPENROUTER_HEAVY_THINKING_MODEL=openai/gpt-5.2
```

## Legacy Per-Agent Overrides (Still Supported)

Per-agent overrides take precedence over tier defaults for backward compatibility.

| Variable                  | Purpose              | Fallback           |
| ------------------------- | -------------------- | ------------------ |
| `{PREFIX}_{ROLE}_MODEL`   | Agent-specific model | Tier default       |
| `{PREFIX}_{ROLE}_API_KEY` | Agent-specific key   | `{PREFIX}_API_KEY` |

Where `{ROLE}` = `ORCHESTRATOR`, `PLANNER`, `RESEARCHER`, `MEMORY`, `ANSWER`, or `TOOL_USE`.

## Configuration Priority

Highest to lowest:

1. Per-agent env vars (e.g., `OPENROUTER_PLANNER_MODEL`) — legacy, highest priority
2. Tier-based models (e.g., `OPENROUTER_HEAVY_THINKING_MODEL`) — new, recommended
3. Provider default model (e.g., `OPENROUTER_MODEL`)
4. Provider preset defaults (hardcoded in `PROVIDER_PRESETS`)

## All Environment Variables

### LLM

| Variable                        | Default            | Description                |
| ------------------------------- | ------------------ | -------------------------- |
| `LLM_PROVIDER`                  | `openrouter`       | Provider backend           |
| `{PREFIX}_API_KEY`              | None               | API authentication         |
| `{PREFIX}_MODEL`                | Provider-specific  | Default model              |
| `{PREFIX}_BASE_URL`             | Provider default   | Override base URL          |
| `{PREFIX}_SMALL_FAST_MODEL`     | `{PREFIX}_MODEL`   | Small/fast tier model      |
| `{PREFIX}_MIDTIER_MODEL`        | `{PREFIX}_MODEL`   | Mid-tier model             |
| `{PREFIX}_HEAVY_THINKING_MODEL` | `{PREFIX}_MODEL`   | Heavy thinking tier model  |
| `{PREFIX}_{ROLE}_MODEL`         | Tier default       | Per-agent model override   |
| `{PREFIX}_{ROLE}_API_KEY`       | `{PREFIX}_API_KEY` | Per-agent API key override |

### Knowledge Formation

| Variable                              | Default    | Description                              |
| ------------------------------------- | ---------- | ---------------------------------------- |
| `KNOWLEDGE_FORMATION_ENABLED`         | `true`     | Enable knowledge extraction              |
| `KNOWLEDGE_FORMATION_SENSITIVITY`     | `balanced` | Preset: aggressive/balanced/conservative |
| `KNOWLEDGE_FORMATION_MIN_CONFIDENCE`  | `0.7`      | Min confidence to store                  |
| `KNOWLEDGE_FORMATION_MAX_LEARNINGS`   | `3`        | Max learnings per task                   |
| `KNOWLEDGE_FORMATION_DEDUP_THRESHOLD` | `0.9`      | Deduplication similarity                 |
| `KNOWLEDGE_FORMATION_EXCLUDE_AGENTS`  | (empty)    | Comma-separated agent types              |
| `KNOWLEDGE_FORMATION_DEBUG`           | `false`    | Debug logging                            |

### Outcome Tracking

| Variable                             | Default | Description                  |
| ------------------------------------ | ------- | ---------------------------- |
| `OUTCOME_TRACKING_ENABLED`           | `true`  | Enable outcome tracking      |
| `OUTCOME_TRACKING_CRITIC_ENABLED`    | `true`  | Enable critic evaluation     |
| `OUTCOME_TRACKING_SIMILARITY_WEIGHT` | `0.5`   | Similarity re-ranking weight |
| `OUTCOME_TRACKING_SUCCESS_WEIGHT`    | `0.3`   | Success rate weight          |
| `OUTCOME_TRACKING_RECENCY_WEIGHT`    | `0.2`   | Recency weight               |
| `OUTCOME_TRACKING_MAX_HISTORY`       | `10`    | Max application history      |
| `OUTCOME_TRACKING_MIN_APPLICATIONS`  | `3`     | Min apps for ranking         |

### Middleware

| Variable                       | Default  | Description                       |
| ------------------------------ | -------- | --------------------------------- |
| `SUMMARIZATION_TRIGGER_TOKENS` | `170000` | Token threshold for summarization |
| `SUMMARIZATION_KEEP_MESSAGES`  | `20`     | Messages to preserve              |
| `COST_TRACKING_CACHE_TTL_MS`   | (unset)  | Pricing cache TTL                 |

### Services

| Variable            | Default     | Description               |
| ------------------- | ----------- | ------------------------- |
| `TAVILY_API_KEY`    | (empty)     | Tavily web search API key |
| `GRAPH_MEMORY_API`  | (empty)     | Full memory API URL       |
| `GRAPH_MEMORY_HOST` | `localhost` | Memory server hostname    |
| `GRAPH_MEMORY_PORT` | `8080`      | Memory server port        |

### Runtime

| Variable              | Default       | Description                             |
| --------------------- | ------------- | --------------------------------------- |
| `LOG_LEVEL`           | `info`        | Verbosity: debug/info/warn/error/silent |
| `NODE_ENV`            | `development` | Environment                             |
| `SIA_PROJECT_ROOT`    | (unset)       | Project root for worktrees              |
| `SIA_CLI_SOCKET_PATH` | (unset)       | IPC socket for CLI                      |

## Model Factory Functions

Defined in `model-config.ts`. Each resolves provider config for a specific agent role:

| Function                | Agent Role | Checks Override             |
| ----------------------- | ---------- | --------------------------- |
| `createChatModel()`     | General    | `{PREFIX}_MODEL`            |
| `createPlanModel()`     | Planner    | `{PREFIX}_PLANNER_MODEL`    |
| `createResearchModel()` | Researcher | `{PREFIX}_RESEARCHER_MODEL` |
| `createMemoryModel()`   | Memory     | `{PREFIX}_MEMORY_MODEL`     |
| `createAnswerModel()`   | Answer     | `{PREFIX}_ANSWER_MODEL`     |

Deprecated aliases kept for backward compatibility: `createOpenRouterModel` → `createChatModel`, `createPlannerModel` → `createPlanModel`, `createResearcherModel` → `createResearchModel`.

## Validation

`validateConfig()` checks at startup:

- Required API keys for remote providers
- Custom provider has base URL set
- Numeric ranges (confidence, thresholds) are valid
- Re-ranking weights sum to ~1.0
- Warns about missing optional keys (Tavily)

## Tests

- `tests/unit/config/llm-providers.test.ts` — Provider resolution tests (24 tests)
- `tests/unit/config/loader.test.ts` — Config loader tests
- `tests/unit/config/validate.test.ts` — Validation tests
