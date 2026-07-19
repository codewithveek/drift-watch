import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { detectBehavioralDrift } from './detector.js';
import type { ModelClient } from '../model-client.js';

/**
 * Exercises the drift judge end to end against a mock model, reproducing the
 * real-world Qwen failure mode: the provider ignores structured-output mode and
 * the model answers with a markdown report instead of JSON. The judge must
 * salvage/retry rather than throw a JSON SyntaxError.
 */

// The exact result shape `doGenerate` must return, derived from the mock so we
// don't depend on @ai-sdk/provider's result-type name (which `ai` doesn't
// re-export). The explicit annotation contextually types the literals below.
type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function mockReply(text: string): MockGenerateResult {
  return {
    content: [{ type: 'text', text }],
    // Spec v4 finishReason is an object, not a bare string.
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
  };
}

const VALID_VERDICT_JSON = JSON.stringify({
  drift: true,
  severity: 'high',
  reasons: ['p95 latency 180ms -> 450ms', 'search_docs share 40% -> 75%'],
  recommended_action: 'Investigate the search_docs regression.',
});

// The exact prose shape that broke generateObject in production.
const MARKDOWN_REPORT = `# 🚨 DRIFT ALERT — Human Review Recommended

## Executive Summary

**Verdict: ALERT** — Multiple high-severity drift signals detected.

## Dimension-by-Dimension Analysis

- Latency regressed sharply.`;

function makeModel(replies: string[]): ModelClient {
  return new MockLanguageModelV4({
    doGenerate: replies.map(mockReply),
  }) as unknown as ModelClient;
}

describe('detectBehavioralDrift judge (dry-run fixtures)', () => {
  it('salvages a JSON object embedded in a markdown report on the first try', async () => {
    const model = makeModel([
      `${MARKDOWN_REPORT}\n\n\`\`\`json\n${VALID_VERDICT_JSON}\n\`\`\``,
    ]);

    const report = await detectBehavioralDrift({ modelClient: model, isDryRun: true });

    expect(report.verdict.drift).toBe(true);
    expect(report.verdict.severity).toBe('high');
    expect(report.verdict.reasons.length).toBeGreaterThan(0);
    expect(report.judgeAttempts).toBe(1);
  });

  it('retries with a correction when the first reply is pure prose, then succeeds', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [mockReply(MARKDOWN_REPORT), mockReply(VALID_VERDICT_JSON)],
    });

    const report = await detectBehavioralDrift({
      modelClient: model as unknown as ModelClient,
      isDryRun: true,
    });

    expect(report.verdict.drift).toBe(true);
    expect(report.judgeAttempts).toBe(2);
    // Usage should accumulate across both attempts (2 x 100 input, 2 x 20 output).
    expect(report.judgeTokenUsage.inputTokens).toBe(200);
    expect(report.judgeTokenUsage.outputTokens).toBe(40);
    expect(model.doGenerateCalls.length).toBe(2);
  });

  it('throws a descriptive error when the model never returns valid JSON', async () => {
    const model = makeModel([
      MARKDOWN_REPORT,
      MARKDOWN_REPORT,
      MARKDOWN_REPORT,
    ]);

    await expect(
      detectBehavioralDrift({ modelClient: model, isDryRun: true }),
    ).rejects.toThrow(/did not return a schema-valid JSON verdict/);
  });
});
