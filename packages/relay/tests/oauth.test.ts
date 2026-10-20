// The OAuth callback: the app's `ca1.` envelope in, a redirect to the app's loopback or scheme out.
import { afterAll, describe, expect, test } from 'bun:test';
import { acceptableReturnTo, decodeRelayState, handleOAuthCallback } from '../src/oauth.ts';
import { relay } from './helpers.ts';

// The app's own encoder, loaded by path so the relay package never depends on @memwise/shared.
const sharedOAuthRelay = '../../shared/src/auth/oauth-relay.ts';
const { encodeOAuthRelayState } = (await import(sharedOAuthRelay)) as { encodeOAuthRelayState: (returnTo: string, inner: string) => string };

const r = relay({ oauthReturnOrigins: ['https://agents.example.com'] });
afterAll(() => r.stop());

const callback = (params: Record<string, string>) =>
  fetch(`${r.url}/auth/callback?${new URLSearchParams(params)}`, { redirect: 'manual' });

describe('the OAuth callback', () => {
  test('decodes the app\'s envelope', () => {
    const state = encodeOAuthRelayState('http://localhost:53122/callback', 'inner-1');
    expect(decodeRelayState(state)).toEqual({ returnTo: 'http://localhost:53122/callback', innerState: 'inner-1' });
    expect(decodeRelayState('plain-state')).toBeNull();
    expect(decodeRelayState('ca1.!!!')).toBeNull();
    expect(decodeRelayState('ca1.' + btoa(JSON.stringify({ v: 2, r: 'x', s: 'y' })))).toBeNull();
  });

  test('the desktop app\'s loopback callback gets the code and the inner state', async () => {
    const state = encodeOAuthRelayState('http://localhost:53122/callback', 'inner-state-1');
    const res = await callback({ code: 'the-code', state });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe('http://localhost:53122/callback');
    expect(to.searchParams.get('code')).toBe('the-code');
    expect(to.searchParams.get('state')).toBe('inner-state-1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('errors are passed on', async () => {
    const state = encodeOAuthRelayState('http://127.0.0.1:4000/callback?keep=1', 's');
    const res = await callback({ error: 'access_denied', error_description: 'The user said no', state });
    const to = new URL(res.headers.get('location')!);
    expect(to.searchParams.get('keep')).toBe('1');
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('error_description')).toBe('The user said no');
    expect(to.searchParams.get('state')).toBe('s');
    expect(to.searchParams.get('code')).toBeNull();
  });

  test('the app\'s schemes, [::1] and listed origins are accepted', () => {
    for (const ok of ['memwise://auth-callback', 'craftagents://auth-callback?x=1', 'http://[::1]:5000/callback', 'http://localhost:1/x']) {
      expect(acceptableReturnTo(ok)).not.toBeNull();
    }
    expect(acceptableReturnTo('https://agents.example.com/api/oauth/callback', ['https://agents.example.com'])).not.toBeNull();
  });

  test('anything else is a plain 400 page', async () => {
    const bad = [
      'https://evil.example/steal',
      'http://localhost/callback', // no port
      'https://localhost:443/callback', // loopback is plain http
      'http://localhost.evil.example:80/callback',
      'http://user:pass@localhost:5000/callback',
      'http://10.0.0.1:5000/callback',
      'javascript:alert(1)',
      'https://agents.example.com.evil/x',
      'http://agents.example.com/api/oauth/callback', // listed origins are https only
    ];
    for (const returnTo of bad) {
      const res = await callback({ code: 'c', state: encodeOAuthRelayState(returnTo, 's') });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('does not send codes to');
    }
    expect((await callback({ code: 'c' })).status).toBe(400);
    expect((await callback({ code: 'c', state: 'not-an-envelope' })).status).toBe(400);
    expect((await callback({ state: encodeOAuthRelayState('http://localhost:5000/callback', 's') })).status).toBe(400);
  });

  test('a listed web UI origin is accepted over the relay too', async () => {
    const state = encodeOAuthRelayState('https://agents.example.com/api/oauth/callback', 'w');
    const res = await callback({ code: 'c', state });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toStartWith('https://agents.example.com/api/oauth/callback?');
  });

  test('handleOAuthCallback stores nothing and needs no host', () => {
    const state = encodeOAuthRelayState('memwise://auth-callback', 'x');
    const res = handleOAuthCallback(new URL(`https://relay/auth/callback?code=1&state=${encodeURIComponent(state)}`), {});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('memwise://auth-callback?code=1&state=x');
  });
});
