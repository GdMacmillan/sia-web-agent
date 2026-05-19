# Agent Architecture Research

A survey of agent design patterns and an analysis of Claude Code's
architecture based on community reverse-engineering. Captured here as
reference material for any future change to this agent's own architecture
— if you're considering replacing or augmenting the ReAct loop, this is
the prior art to compare against.

## Alternatives to the ReAct architecture

The ReAct pattern (Thought → Action → Observation loop) is the most
widely used baseline for LLM agent systems, but several alternatives
address its limitations.

### 1. Plan-and-Execute

- **How it works**: Two-phase approach — an LLM planner generates a full
  task decomposition upfront, then an executor (which can itself be a
  ReAct agent) works through each step sequentially.
- **Advantage**: More token-efficient for complex multi-step tasks;
  enables using a powerful model for planning and a cheaper model for
  execution.
- **Weakness**: Less adaptive to unexpected intermediate results;
  requires explicit replanning when the initial plan is wrong.
- **Best for**: Long-horizon tasks with clear decomposition (multi-module
  coding, research projects).
- **Origin**: [LangChain blog (2023)](https://blog.langchain.com/plan-and-execute-agents), inspired by BabyAGI.

### 2. ReWOO (Reasoning Without Observation)

- **How it works**: Generates the complete tool-call sequence in a
  single planning pass using placeholder variables (`#E1`, `#E2`) for
  future results. Executes all tool calls, then a solver synthesizes
  the final answer.
- **Advantage**: Dramatic token and latency reduction — eliminates the
  repetitive prompt overhead of ReAct's observation-reasoning loops.
- **Weakness**: Brittle if assumptions break mid-execution since there's
  no intermediate adaptation.
- **Best for**: Routine, templatable workflows (multi-hop Q&A,
  predictable tool sequences).
- **Reference**: [Comparing ReAct and ReWOO](https://spr.com/comparing-react-and-rewoo-two-frameworks-for-building-ai-agents-in-generative-ai/).

### 3. Reflexion

- **How it works**: Multi-trial learning. Runs Plan → Execute → Evaluate
  → Reflect → Update Memory across multiple attempts. Maintains a
  persistent reflection memory of insights from failures.
- **Advantage**: Learns from failures; accumulated knowledge improves
  subsequent attempts.
- **Weakness**: Very expensive — multiple LLM calls per trial across
  multiple trials.
- **Best for**: Tasks requiring iterative improvement (optimization,
  problem-solving with trial and error).
- **Reference**: [Reflexion Agent Pattern](https://agent-patterns.readthedocs.io/en/latest/patterns/reflexion.html).

### 4. LATS (Language Agent Tree Search)

- **How it works**: Combines Monte Carlo Tree Search (MCTS) with LLM
  self-reflection. Explores the problem-solving space as a tree,
  evaluating leaf nodes and using backpropagation to guide search.
- **Advantage**: Outperforms ReAct, Reflexion, and Tree of Thoughts on
  complex reasoning tasks by balancing exploration and exploitation.
- **Weakness**: Extremely expensive computationally; very advanced to
  implement.
- **Best for**: Complex reasoning tasks with multiple valid solution paths.
- **Reference**: [LATS Agent Pattern](https://agent-patterns.readthedocs.io/en/stable/patterns/lats.html).

### 5. Tree of Thoughts (ToT)

- **How it works**: Breadth-first search through reasoning space:
  expand multiple candidate thoughts → score them → prune losers →
  repeat.
- **Advantage**: Explores multiple reasoning paths simultaneously;
  prevents commitment to dead ends.
- **Weakness**: Computationally expensive; needs a mechanism for scoring
  partial solutions.
- **Best for**: Puzzles, optimization, creative/strategic problems.

### 6. RAISE (ReAct + Examples + Scratchpad)

- **How it works**: Extends ReAct with a persistent scratchpad for
  intermediate state and few-shot examples embedded in the prompt.
- **Advantage**: Better grounding than vanilla ReAct through maintained
  working memory.
- **Best for**: Tasks where intermediate state accumulation matters.

### Comparison

| Architecture | Adaptability | Cost | Planning | Best for |
|---|---|---|---|---|
| **ReAct** | High | Medium | Minimal | Open-ended, dynamic |
| **Plan-and-Execute** | Medium | Good | Explicit upfront | Structured multi-step |
| **ReWOO** | Low-Medium | Excellent | Single-pass | Routine workflows |
| **Reflexion** | High | Very High | Per-trial | Learning from failures |
| **LATS** | Very High | Very High | Tree search | Complex reasoning |
| **Tree of Thoughts** | Very High | Poor | Implicit breadth | Puzzles, optimization |
| **Multi-Agent** | High | Variable | Architecture-dependent | Large diverse applications |

These patterns aren't mutually exclusive. Production systems often
combine them — for example, a Plan-and-Execute orchestrator that spawns
ReAct sub-agents, or a multi-agent system where individual agents use
Reflexion internally.

### Relevance to this agent

This agent currently uses a ReAct-style pattern at every tier (manager,
plan, research, answer). Architectural moves worth considering during
self-modification cycles:

- **Plan-and-Execute for the manager** — the manager already does
  informal planning via the plan sub-agent; a formal Plan-and-Execute
  split could reduce token usage and improve multi-step task handling.
- **ReWOO for routine research** — predictable research workflows
  ("find all files matching X, read them, summarize") could benefit
  from single-pass planning.
- **Reflexion for self-improvement** — the self-modification workflow
  already has elements of Reflexion (try → validate → learn). Making
  this explicit could improve experiment quality.

---

## Does Claude Code use ReAct under the hood?

Multiple reverse-engineering efforts have analyzed Claude Code's
architecture by intercepting API traffic, analyzing the NPM bundle, and
tracing token flows. A synthesis of community findings follows. Useful
as a reference architecture when considering changes to this agent.

### Sources

- [Context Engineering & Reuse Pattern Under the Hood of Claude Code](https://huggingface.co/blog/kobe0938/context-engineering-reuse-pattern-claude-code) — HuggingFace community article with detailed trace analysis.
- [Claude Code: Behind-the-scenes of the master agent loop](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/) — PromptLayer analysis.
- [Reverse engineering Claude Code](https://kirshatrov.com/posts/claude-code-internals) — Kir Shatrov's early analysis via mitmproxy.
- [Reverse engineering Claude Code](https://reidbarber.com/blog/reverse-engineering-claude-code) — Reid Barber's source map analysis.
- [I Reverse-Engineered Claude Code](https://www.youtube.com/watch?v=i0P56Pm1Q3U) — video walkthrough of API interception.

### The core loop

Claude Code implements a **single-threaded master agent loop**
(internally codenamed `nO` per PromptLayer's analysis). It follows the
fundamental ReAct cycle:

> **Reason → Act (tool call) → Observe (tool result) → Loop** until a
> final response with no tool calls is produced.

However, it's more precisely described as a **REPL-based agentic loop**
rather than a textbook ReAct implementation. The key distinction:
Claude Code doesn't use explicit "Thought / Action / Observation"
prompt formatting. Instead, it relies on Claude's native tool-calling
API where reasoning happens implicitly in the model's response before
tool invocations.

### Sub-agent architecture

Claude Code uses a `dispatch_agent` tool (exposed as `Task` in the
user-facing interface) with these characteristics:

- **At most one level deep** — sub-agents cannot spawn their own
  sub-agents (prevents recursive explosion).
- **3 sub-agent types**: Explore (file-search specialist), Plan
  (software architect), and a bash command extraction agent.
- **Parallel execution**: up to 3 explore sub-agents can run
  simultaneously.
- **Context isolation**: sub-agents receive reduced tool sets (~10 of
  18) and only summarized context from the parent, not the full
  conversation history.
- **Each sub-agent runs its own ReAct-style loop** independently.

### Execution phases

Based on trace analysis, a typical Claude Code session follows this
flow:

1. **Warm-up** (`#2–#5`): prime KV cache with tool-list specs,
   sub-agent system prompts, and summarization agent prompts.
2. **Exploration** (`#6–#45`): main agent spawns up to 3 parallel
   explore sub-agents, each running independent ReAct loops.
3. **Planning** (`#46–#72`): main agent aggregates exploration findings,
   invokes the plan sub-agent with summarized context.
4. **Execution** (`#73–#92`): main agent executes planned steps — file
   edits, bash commands, todo updates — with user approval gates.

### Key architectural insights

1. **Prefix caching is the architectural driver.** The system is heavily
   optimized for KV-cache reuse. One trace showed 92% prefix reuse
   across a 2M-token session, reducing costs by ~81%. The architecture
   (warm-up calls, context isolation, parallel agents) appears designed
   *around* cache optimization, not incidentally.

   | Phase | Total tokens | Prefix reuse rate |
   |---|---|---|
   | Warm-up & init | 47,177 | 0.22% |
   | Explore phase | 546,104 | 92.06% |
   | Plan phase | 528,286 | 93.23% |
   | Execution phase | 827,411 | 97.83% |
   | **Overall** | **~2M** | **92%** |

2. **Model stratification.** Sonnet for reasoning, Haiku for simpler
   parsing tasks (topic detection, command extraction).

3. **Simplicity over sophistication.** Design philosophy: "do the simple
   thing first" — regex over embeddings for search, Markdown files over
   databases for memory. No RAG, vector stores, or complex orchestration
   frameworks.

4. **Safety-first execution.** Bash commands go through two-stage
   LLM-based security validation. URL fetching is restricted to
   user-mentioned or project-documented hosts.

5. **Context management.** A compressor triggers at ~92% context-window
   usage for summarization. TodoWrite maintains structured task state
   injected into system messages to prevent objective drift during long
   conversations.

6. **Real-time steering.** An asynchronous dual-buffer queue (`h2A`)
   enables mid-task user interjections without restarting the agent
   loop — pause/resume and dynamic plan adjustment during execution.

### Verdict

The reverse-engineering community largely agrees that **Claude Code
uses a ReAct-like agentic loop** at its core, but with significant
engineering around it:

- It is not a naive ReAct implementation.
- The real innovation is in **context engineering** (prefix caching,
  context isolation, model stratification) rather than exotic agent
  architectures.
- Sub-agents are ReAct loops with restricted scope, not a different
  pattern.
- The system is closer to a **hierarchical multi-agent system with
  ReAct internals** than any single alternative pattern.
- The architecture is "optimized for KV cache reuse" as the primary
  design concern, with the agent pattern being relatively straightforward
  underneath.

### Patterns worth referencing

These are patterns from Claude Code that any change to this agent's
architecture should consider against. Whether they apply depends on
the current state of the codebase — verify before committing to any of
them in a self-modification cycle.

- Hard depth limit on sub-agent spawning (Claude Code: 1).
- Parallel sub-agent execution.
- Aggressive context isolation between parent and sub-agents.
- Prefix-cache-friendly prompt structure (stable prefixes, mutable
  suffixes).
- Model stratification (small/fast for routing and parsing,
  midtier/heavy for reasoning).
- Markdown-based state for human-readable agent memory.
- Auto-triggered summarization near context limits.

---

*Research conducted: February 2026.*
