import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OAuthFlowStore, createPendingFlow } from '@memwise/shared/auth';
import { createWebuiHandler } from '../http-server';

const TEMP_DIRS: string[] = [];

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memwise-webui-oauth-test-'));
  TEMP_DIRS.push(dir);
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>');
  return dir;
}

function createFlow(state: string) {
  return createPendingFlow({
    flowId: `flow-${state}`,
    state,
    codeVerifier: 'verifier',
    redirectUri: 'https://thecraftagents.com/auth/callback',
    source: {} as any,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    provider: 'google',
    ownerClientId: 'client-1',
    workspaceId: 'workspace-1',
    sourceSlug: 'gmail',
    sessionId: 'session-1',
    authRequestId: 'auth-1',
  });
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('WebUI /api/oauth/callback', () => {
  it('completes OAuth when the relay forwards the inner flow state', async () => {
    const flowStore = new OAuthFlowStore();
    const flow = createFlow('inner-state-123');
    flowStore.store(flow);
    const fanOuts: unknown[][] = [];

    const handler = createWebuiHandler({
      webuiDir: createTestWebuiDir(),
      secret: 'test-secret',
      password: 'test-password',
      wsProtocol: 'wss',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
    });

    handler.setOAuthCallbackDeps({
      flowStore,
      credManager: {
        exchangeAndStore: async () => ({ success: true, email: 'gyula@craft.do' }),
      },
      sessionManager: {
        completeAuthRequest: async () => {},
        completeAuthRequestsForSource: (...args) => { fanOuts.push(args); return ['session-1']; },
      },
      pushSourcesChanged: () => {},
    });

    try {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/api/oauth/callback?code=auth-code-123&state=inner-state-123'),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Authorization Successful');
      expect(flowStore.getByState('inner-state-123')).toBeNull();
      // Every session waiting on the source in the workspace is answered, not only the card's
      expect(fanOuts).toEqual([[
        'workspace-1', 'gmail', { email: 'gyula@craft.do' }, [{ sessionId: 'session-1', authRequestId: 'auth-1' }],
      ]]);
      expect(flowStore.getStatus(flow.flowId, 'workspace-1')).toEqual({
        live: false,
        outcome: { success: true, error: undefined, email: 'gyula@craft.do' },
      });
    } finally {
      handler.dispose();
      flowStore.dispose();
    }
  });

  it('renders an OAuth failure page when the relay forwards provider errors', async () => {
    const flowStore = new OAuthFlowStore();
    const flow = createFlow('inner-state-456');
    flowStore.store(flow);

    const handler = createWebuiHandler({
      webuiDir: createTestWebuiDir(),
      secret: 'test-secret',
      password: 'test-password',
      wsProtocol: 'wss',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
    });

    handler.setOAuthCallbackDeps({
      flowStore,
      credManager: {
        exchangeAndStore: async () => ({ success: true }),
      },
      sessionManager: {
        completeAuthRequest: async () => {},
        completeAuthRequestsForSource: () => [],
      },
      pushSourcesChanged: () => {},
    });

    try {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/api/oauth/callback?error=access_denied&error_description=User%20denied&state=inner-state-456'),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Authorization Failed');
      expect(flowStore.getByState('inner-state-456')).toBeNull();
      // Clients that joined the flow learn why it ended
      expect(flowStore.getStatus(flow.flowId, 'workspace-1')).toEqual({
        live: false,
        outcome: { success: false, error: 'User denied', email: undefined },
      });
    } finally {
      handler.dispose();
      flowStore.dispose();
    }
  });
});
