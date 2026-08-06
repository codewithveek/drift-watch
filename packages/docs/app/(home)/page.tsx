import Link from 'next/link';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';

const install = `npm install @driftwatch/sdk ai zod
npm install @ai-sdk/openai   # or any AI SDK provider you already use`;

// Runnable: the tool calls GitHub's public API (no key needed); only the
// model needs a key. See /docs/sdk for the full walkthrough.
const snippet = `import { runAgentTask } from '@driftwatch/sdk';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const tools = {
  get_repo: tool({
    description: 'Get public information about a GitHub repository',
    inputSchema: z.object({ owner: z.string(), repo: z.string() }),
    execute: async ({ owner, repo }) => {
      const res = await fetch(\`https://api.github.com/repos/\${owner}/\${repo}\`);
      const data = await res.json();
      return { stars: data.stargazers_count, language: data.language };
    },
  }),
};

const result = await runAgentTask({
  prompt: 'How many stars does vercel/next.js have?',
  modelClient: openai('gpt-4o-mini'),
  tools,
});

console.log(result.responseText);
// → "vercel/next.js has 129,304 stars."

// Add bootstrapTelemetry (a one-line preload) to send this over OTLP.
// Full walkthrough: /docs/sdk`;

const packages = [
  {
    name: '@driftwatch/sdk',
    tag: 'The product',
    description:
      'Telemetry, drift detection, guardrails, and the full Autopilot orchestration engine. Zero provider SDKs, zero required dependencies.',
  },
  {
    name: '@driftwatch/autopilot',
    tag: 'Companion',
    description:
      'Concrete Slack, Telegram, and webhook notifiers, plus inbound-webhook verification. Bring it in only if you use those channels.',
  },
  {
    name: '@driftwatch/server',
    tag: 'Reference',
    description:
      'A ready-to-run Fastify service built on @driftwatch/sdk and @driftwatch/autopilot - the fastest way to see DriftWatch working.',
  },
  {
    name: '@driftwatch/console',
    tag: 'Reference',
    description:
      'The operator web console for the reference server: approvals, drift feed, action log, agent health.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 py-20 text-center sm:py-28">
        <p className="rounded-full border px-3 py-1 text-xs font-medium text-fd-muted-foreground">
          A self-observing AI agent SDK
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Know when your agent starts behaving differently.
        </h1>
        <p className="max-w-2xl text-balance text-fd-muted-foreground sm:text-lg">
          DriftWatch traces every tool call and model step as OpenTelemetry, runs
          a model over that telemetry to detect behavioral drift, and closes the
          loop with a policy-driven autopilot to notify, pause, rollback, or throttle
          with a human in the loop for anything destructive.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            href="/docs/quickstart"
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Quickstart
          </Link>
          <Link
            href="/docs/sdk"
            className="rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            SDK docs
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 pb-16">
        <div className="overflow-hidden rounded-xl border">
          <DynamicCodeBlock lang="bash" code={install} />
        </div>
        <div className="mt-4 overflow-hidden rounded-xl border">
          <DynamicCodeBlock lang="ts" code={snippet} />
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-4 pb-24">
        <h2 className="mb-6 text-center text-sm font-medium uppercase tracking-wide text-fd-muted-foreground">
          The packages
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {packages.map((pkg) => (
            <div key={pkg.name} className="rounded-xl border p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <code className="text-sm font-semibold">{pkg.name}</code>
                <span className="rounded-full bg-fd-accent px-2 py-0.5 text-[11px] font-medium text-fd-accent-foreground">
                  {pkg.tag}
                </span>
              </div>
              <p className="text-sm text-fd-muted-foreground">{pkg.description}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
