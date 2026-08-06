/** Tiny POST-JSON helper with a hard timeout, shared by the notifiers. */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 5_000,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
