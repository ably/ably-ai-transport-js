import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export function createModel(): LanguageModel {
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6');
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return process.env.AI_GATEWAY_MODEL ?? 'openai/gpt-4o-mini';
  }

  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
    return openai(process.env.OPENAI_MODEL ?? 'gpt-4o');
  }

  throw new Error('No AI provider configured. Set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
}
