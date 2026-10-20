// The OAuth callback at the relay (23 §8). A provider redirects here with `code` and the
// app's `ca1.` state envelope (packages/shared/src/auth/oauth-relay.ts, decoded again here
// so the relay stays standalone); the relay sends the browser on to the `returnTo` inside
// it. Nothing is stored, and only addresses the app itself produces are accepted, so the
// relay can't be used to hand a code to someone else's site.
import type { RelayConfig } from './hub.ts';
import { htmlResponse, RESPONSE_SECURITY_HEADERS } from './http.ts';
import { fromBase64Url } from './protocol-impl.ts';

const STATE_PREFIX = 'ca1.';
const STATE_VERSION = 1;
const MAX_STATE_CHARS = 8192;

/** The app's own URL schemes (deep links back into the desktop app). */
const APP_SCHEMES = new Set(['memwise:', 'craftagents:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function decodeRelayState(value: string): { returnTo: string; innerState: string } | null {
  if (!value.startsWith(STATE_PREFIX) || value.length > MAX_STATE_CHARS) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(value.slice(STATE_PREFIX.length)))) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== STATE_VERSION) return null;
    if (typeof parsed.r !== 'string' || !parsed.r || typeof parsed.s !== 'string' || !parsed.s) return null;
    return { returnTo: parsed.r, innerState: parsed.s };
  } catch {
    return null;
  }
}

/**
 * Whether the relay may redirect to `returnTo`: the desktop app's loopback callback
 * (`http://localhost:<port>/…`, also 127.0.0.1 and [::1]), the app's own schemes, or an
 * origin the relay's operator listed (a web UI's address).
 */
export function acceptableReturnTo(returnTo: string, extraOrigins: string[] = []): URL | null {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (APP_SCHEMES.has(url.protocol)) return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.port) return url;
  if (extraOrigins.some((o) => sameOrigin(o, url))) return url;
  return null;
}

function sameOrigin(origin: string, url: URL): boolean {
  try {
    const o = new URL(origin);
    return o.protocol === 'https:' && o.origin === url.origin;
  } catch {
    return false;
  }
}

const badRequest = (message: string) => htmlResponse(400, "This sign-in can't be finished here", message);

export function handleOAuthCallback(url: URL, config: Pick<RelayConfig, 'oauthReturnOrigins'>): Response {
  const params = url.searchParams;
  const state = params.get('state');
  if (!state) return badRequest('The sign-in link is missing its state. Start signing in again from the app.');
  const decoded = decodeRelayState(state);
  if (!decoded) return badRequest('The sign-in state is not one this relay understands. Start signing in again from the app.');
  const target = acceptableReturnTo(decoded.returnTo, config.oauthReturnOrigins);
  if (!target) return badRequest('The sign-in asked to return to an address this relay does not send codes to.');

  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return badRequest('The sign-in came back without a code. Start signing in again from the app.');

  if (code) target.searchParams.set('code', code);
  target.searchParams.set('state', decoded.innerState);
  if (error) target.searchParams.set('error', error);
  const description = params.get('error_description');
  if (description) target.searchParams.set('error_description', description);

  return new Response(null, {
    status: 302,
    headers: [['location', target.toString()], ['cache-control', 'no-store'], ...RESPONSE_SECURITY_HEADERS],
  });
}
