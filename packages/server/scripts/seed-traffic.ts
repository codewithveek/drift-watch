/**
 * Fire N requests at the running agent so a tracing backend has enough
 * signal for the drift detector. Mix of prompts biased toward one skill
 * early, another later, so the drift verdict has something real to catch.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 AUTH_TOKEN=... tsx scripts/seed-traffic.ts 40
 */
const agentBaseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const authToken = process.env.AUTH_TOKEN ?? '';
const requestCount = Number(process.argv[2] ?? 20);

const weatherPrompts = [
  'weather in Lagos',
  'weather in Tokyo',
  'weather in São Paulo',
  'weather in Berlin',
];
const searchDocsPrompts = [
  'search docs for onboarding',
  'search docs for retention policy',
  'search docs for release process',
  'search docs for RBAC changes',
];

interface SendAgentRunRequestResult {
  statusCode: number;
  responseBodyPreview: string;
}

async function sendAgentRunRequest(
  prompt: string,
): Promise<SendAgentRunRequestResult> {
  const response = await fetch(`${agentBaseUrl}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({ prompt }),
  });
  const responseBody = await response.text();
  return {
    statusCode: response.status,
    responseBodyPreview: responseBody.slice(0, 120),
  };
}

function pickPromptForRequestIndex(requestIndex: number): string {
  // First half weather-heavy, second half search-heavy — a real toolMix shift.
  const weatherPromptProbability = requestIndex < requestCount / 2 ? 0.75 : 0.25;
  return Math.random() < weatherPromptProbability
    ? weatherPrompts[requestIndex % weatherPrompts.length]
    : searchDocsPrompts[requestIndex % searchDocsPrompts.length];
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function seedTraffic(): Promise<void> {
  console.log(`Firing ${requestCount} requests at ${agentBaseUrl}/run ...`);
  for (let requestIndex = 0; requestIndex < requestCount; requestIndex++) {
    const prompt = pickPromptForRequestIndex(requestIndex);
    try {
      const result = await sendAgentRunRequest(prompt);
      console.log(
        `[${requestIndex + 1}/${requestCount}] ${result.statusCode}  ${prompt}`,
      );
    } catch (error) {
      console.error(
        `[${requestIndex + 1}/${requestCount}] failed: ${(error as Error).message}`,
      );
    }
    await delay(200);
  }
  console.log('done. now hit /drift or run `npm run drift`.');
}

seedTraffic().catch((error) => {
  console.error(error);
  process.exit(1);
});
