import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider';
import './global.css';

export const metadata = {
  title: {
    default: 'DriftWatch',
    template: '%s · DriftWatch',
  },
  description:
    'A self-observing AI agent SDK — OpenTelemetry instrumentation, behavioral drift detection, and a policy-driven autopilot with human-in-the-loop approvals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
