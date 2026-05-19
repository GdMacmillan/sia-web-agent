# Test Helpers - Regression Testing Infrastructure

This directory contains the testing infrastructure for the multi-agent regression testing framework.

## Files Overview

### 1. behavior-validator.ts

**Purpose**: Verify agent behavioral patterns instead of exact outputs

**Key Functions**:

- `verifyAgentResponded()` - Checks if agent produced any response
- `verifyToolSequencePattern()` - Validates tool calls match expected pattern
- `verifySubagentDelegation()` - Confirms delegation to specific subagent
- `verifyReActCycleCompletion()` - Ensures AI→Tool→Response cycle completes
- `verifyTaskToolResultHandling()` - Validates task results properly processed

**When to Use**:

- Testing that agent performed expected actions
- Verifying tool calling sequences (tolerating variation)
- Checking state transitions
- Validating subagent delegation

**Example**:

```typescript
const response = await mainAgent.invoke({...});
const result = verifyAgentResponded(response);
expect(result.valid).toBe(true);
```

---

### 2. semantic-assertion.ts

**Purpose**: Validate semantic properties of content (not exact text)

**Key Functions**:

- `expectNonEmptyContent()` - Checks minimum content length
- `expectRelevantKeywords()` - Validates presence of key terms
- `expectCodeBlocks()` - Ensures code is present
- `expectStructuredFormat()` - Checks for markdown/JSON/CSV/YAML
- `expectDiverseVocabulary()` - Detects repetitiveness
- `expectTopicCoverage()` - Validates topic coverage
- `expectNoHallucinations()` - Flags hallucination signs

**When to Use**:

- Validating response quality
- Checking content relevance
- Detecting hallucinations
- Ensuring structured output

**Example**:

```typescript
const contentCheck = expectNonEmptyContent(aiMessage.content, 100);
expect(contentCheck.valid).toBe(true);

const keywordCheck = expectRelevantKeywords(aiMessage.content, [
  "agent",
  "architecture",
  "tools",
]);
expect(keywordCheck.found.length).toBeGreaterThan(0);
```

---

### 3. stability-checker.ts

**Purpose**: Detect hallucinations, variance, and stability issues

**Key Functions**:

- `checkStability()` - Run function multiple times and analyze results
- `analyzeStability()` - Compare multiple results for consistency
- `computeSimilarity()` - Measure text similarity (0-1)
- `detectCircularBehavior()` - Find repeating tool sequences
- `analyzeToolFrequency()` - Examine tool usage distribution
- `estimateQuality()` - Score response quality (A-F grade)

**When to Use**:

- Testing consistency across multiple runs
- Detecting hallucinations (identical responses)
- Checking for deadlock patterns
- Estimating response quality

**Example**:

```typescript
const stability = await checkStability(
  () => agent.invoke({...}),
  3,  // Run 3 times
);

expect(stability.stable).toBe(true);
expect(stability.metrics.uniqueResponses).toBeGreaterThan(1);
```

---

### 4. trajectory-validator.ts (Existing)

**Purpose**: Validate tool calling sequences and patterns

**Key Functions**:

- `extractToolSequence()` - Get all tools called
- `matchesPattern()` - Check if tools match expected pattern
- `hasRequiredTools()` - Verify required tools were called
- `validateFileOperations()` - Check file operation safety
- `validateBashCommands()` - Check bash command safety

**When to Use**:

- Validating tool execution order
- Safety checks for file/bash operations
- Counting tool usage

---

### 5. cost-tracker.ts (Existing)

**Purpose**: Track token usage and API costs

**Features**:

- Model pricing database
- Token counting
- Cost budgeting
- Per-test cost reporting

**When to Use**:

- Preventing cost overruns
- Tracking test expenses
- Budgeting integration tests

---

### 6. test-workspace.ts (Existing)

**Purpose**: Create isolated test environments

**Key Functions**:

- `createTempWorkspace()` - Create temporary test directory
- `cleanup()` - Remove test directory after test

**When to Use**:

- File system tests
- Isolated agent contexts
- Workspace-dependent tests

---

### 7. create-test-agent.ts (Existing)

**Purpose**: Factory for creating test agents

**Key Functions**:

- `initTestContext()` - Setup test observability
- `resetTestContext()` - Cleanup test context
- `createBashTool()` - Create bash execution tool
- `createFileTools()` - Create file operation tools

**When to Use**:

- Creating test agents
- Setting up observability
- Building test tools

---

### 8. test-observability.ts (Existing)

**Purpose**: Logging and debugging for tests

**Key Functions**:

- `logTestStart()` - Log test beginning
- `logTestEnd()` - Log test completion
- `isVerboseMode()` - Check if verbose output enabled

**When to Use**:

- Test logging
- Debug output
- Performance tracking

---

## Testing Patterns

### Pattern 1: Behavioral Assertion

```typescript
import { verifyAgentResponded, verifyToolSequencePattern } from './helpers/behavior-validator';

it('should behave correctly', async () => {
  const response = await agent.invoke({...});

  // Verify behavior
  expect(verifyAgentResponded(response).valid).toBe(true);
  expect(verifyToolSequencePattern(tools, {...}).valid).toBe(true);
});
```

### Pattern 2: Semantic Validation

```typescript
import { expectNonEmptyContent, expectRelevantKeywords } from './helpers/semantic-assertion';

it('should produce quality content', async () => {
  const response = await agent.invoke({...});

  // Validate semantics
  expect(expectNonEmptyContent(content).valid).toBe(true);
  expect(expectRelevantKeywords(content, [...]).valid).toBe(true);
});
```

### Pattern 3: Stability Testing

```typescript
import { checkStability, estimateQuality } from './helpers/stability-checker';

it('should be stable across runs', async () => {
  const stability = await checkStability(
    () => agent.invoke({...}),
    3,
  );

  expect(stability.stable).toBe(true);
  const quality = estimateQuality(stability);
  expect(quality.score).toBeGreaterThan(75);
});
```

---

## Import Patterns

```typescript
// Behavioral assertions
import {
  verifyAgentResponded,
  verifyToolSequencePattern,
  verifyReActCycleCompletion,
  // ... others
} from "./helpers/behavior-validator";

// Semantic assertions
import {
  expectNonEmptyContent,
  expectRelevantKeywords,
  expectCodeBlocks,
  // ... others
} from "./helpers/semantic-assertion";

// Stability checking
import {
  checkStability,
  analyzeStability,
  estimateQuality,
  // ... others
} from "./helpers/stability-checker";

// Existing helpers
import { extractToolSequenceFromState } from "./helpers/trajectory-validator";
import { createTempWorkspace } from "./helpers/test-workspace";
```

---

## Best Practices

1. **Use behavior validators for agent actions**
   - Prefer `verifyAgentResponded()` over checking exact message count

2. **Use semantic assertions for content**
   - Prefer `expectNonEmptyContent()` over `expect(content.length).toBe(123)`
   - Prefer `expectRelevantKeywords()` over `expect(content).toContain('exact string')`

3. **Check stability for important workflows**
   - Run same request 3x with `checkStability()`
   - Use `estimateQuality()` to score results

4. **Combine validators for comprehensive tests**

   ```typescript
   // Good: Multiple validators
   expect(verifyAgentResponded(response).valid).toBe(true);
   expect(expectNonEmptyContent(content).valid).toBe(true);
   expect(verifyToolSequencePattern(tools, {...}).valid).toBe(true);
   ```

5. **Document what you're testing**
   - Use clear test names
   - Add comments explaining assertions

---

## Adding New Helpers

When adding a new test utility:

1. **Create clear interface**
   - Return object with `valid: boolean`
   - Include `reason?: string` for failures
   - Include relevant metrics

2. **Document thoroughly**
   - JSDoc comments
   - Example usage
   - When to use

3. **Export from index** (if creating new file)

   ```typescript
   export { checkStability, analyzeStability } from "./stability-checker";
   ```

4. **Add to this README**
   - Add file description
   - Document functions
   - Add examples

---

## Troubleshooting

### Tests using exact text assertions fail randomly

**Solution**: Switch to semantic assertions

- ❌ `expect(response).toContain('exact string')`
- ✅ `expect(expectRelevantKeywords(response, ['keyword']).valid).toBe(true)`

### Can't detect if agent is hallucinating

**Solution**: Use stability checker

```typescript
const stability = await checkStability(fn, 3);
if (stability.issue === "identical_responses") {
  // Agent is hallucinating
}
```

### Tests timeout with real LLM calls

**Solution**: Set longer timeout and use RUN_SUBSET

```bash
jest.setTimeout(900000); // 15 minutes
RUN_SUBSET=true yarn test
```

### Not sure which validator to use

**Decision tree**:

1. Testing agent actions? → `behavior-validator`
2. Testing content quality? → `semantic-assertion`
3. Testing consistency? → `stability-checker`
4. Testing tool patterns? → `trajectory-validator`

---

**Created**: November 14, 2025
**Last Updated**: November 14, 2025
