/**
 * Provider-switch tests for the chat-model factories.
 *
 * The migration in this branch (AGI-235 follow-up) routes OpenRouter calls
 * through `@langchain/openrouter`'s `ChatOpenRouter` instead of
 * `@langchain/openai`'s `ChatOpenAI`. Other providers stay on `ChatOpenAI`.
 * These tests pin that behavior so future config changes don't silently
 * regress codex models back through OpenAI's Responses API.
 */

import { resetConfig } from "../../../src/config/loader.js";
import { createChatModel } from "../../../src/config/model-config.js";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  resetConfig();
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
});

afterAll(() => {
  process.env = originalEnv;
  resetConfig();
});

describe("createChatModel provider switch", () => {
  it("returns a ChatOpenRouter instance when LLM_PROVIDER=openrouter", async () => {
    process.env.LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.OPENROUTER_MODEL = "openai/gpt-5.1-codex-mini";
    resetConfig();

    const model = await createChatModel();
    expect(model.constructor.name).toBe("ChatOpenRouter");
  });

  it("returns a ChatOpenAI instance when LLM_PROVIDER=openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    resetConfig();

    const model = await createChatModel();
    expect(model.constructor.name).toBe("ChatOpenAI");
  });
});
