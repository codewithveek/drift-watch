/**
 * Shared request-authorization helpers for the bearer-gated control plane.
 *
 * Extracted from routes/agent.ts so /run, /drift, and the new console routes
 * all enforce the exact same gate: a valid bearer when AUTH_TOKEN is set, or
 * local-network-only access when it is not. The integration webhooks
 * (Slack/Telegram) do NOT use this — they carry their own signature auth.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Bearer-token gate. When authToken is empty (dev), we still refuse traffic
 * from anywhere but the local network — model tokens cost money, and this
 * app has zero auth otherwise. Setting AUTH_TOKEN opens it up to any client
 * that presents the matching bearer.
 */
export function isRequestAuthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  authToken: string,
): boolean {
  if (authToken) {
    if (isRequestBearerTokenValid(request, authToken)) return true;
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  if (isRequestFromLocalNetwork(request)) return true;
  reply.code(401).send({
    error:
      'AUTH_TOKEN not configured; remote requests are refused. Set AUTH_TOKEN=<secret> to enable.',
  });
  return false;
}

/**
 * Constant-time comparison so an attacker probing the endpoint can't use
 * response-time differences to recover the token byte by byte. The length
 * check is a fast-path that leaks only the token's length, not its content.
 */
export function isRequestBearerTokenValid(
  request: FastifyRequest,
  authToken: string,
): boolean {
  const authorizationHeader = request.headers.authorization ?? '';
  const [authScheme, bearerToken] = authorizationHeader.split(' ');
  if (authScheme !== 'Bearer' || typeof bearerToken !== 'string') return false;

  const providedTokenBuffer = Buffer.from(bearerToken);
  const expectedTokenBuffer = Buffer.from(authToken);
  if (providedTokenBuffer.length !== expectedTokenBuffer.length) return false;
  return timingSafeEqual(providedTokenBuffer, expectedTokenBuffer);
}

/**
 * RFC 1918 private ranges only. Note 172.16.0.0/12 covers just
 * 172.16.x.x-172.31.x.x — matching on the "172." prefix alone would
 * wrongly admit all of 172.0.0.0/8, including public addresses.
 */
export function isRequestFromLocalNetwork(request: FastifyRequest): boolean {
  const clientIpAddress = request.ip;
  if (
    clientIpAddress === '127.0.0.1' ||
    clientIpAddress === '::1' ||
    clientIpAddress === '::ffff:127.0.0.1' ||
    clientIpAddress.startsWith('10.') ||
    clientIpAddress.startsWith('192.168.')
  ) {
    return true;
  }

  const privateClassBMatch = /^172\.(\d{1,3})\./.exec(clientIpAddress);
  if (!privateClassBMatch) return false;
  const secondOctet = Number(privateClassBMatch[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}
