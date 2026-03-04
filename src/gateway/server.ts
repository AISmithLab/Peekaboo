import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { DataStore } from '../database/datastore.js';
import type { ConnectorRegistry } from './connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { TokenManager } from './auth/token-manager.js';
import { createAppApi } from './app-api.js';
import { createGuiRoutes } from './gui/routes.js';
import { createOAuthRoutes } from './auth/oauth-routes.js';
import { createLoginRoutes } from './auth/login-routes.js';

export interface ServerDeps {
  store: DataStore;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  tokenManager: TokenManager;
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({ ok: true, version: '0.1.0' }));

  // Mount App API
  const appApi = createAppApi(deps);
  app.route('/app/v1', appApi);

  // Mount OAuth routes
  const oauthRoutes = createOAuthRoutes({
    store: deps.store,
    connectorRegistry: deps.connectorRegistry,
    config: deps.config,
    tokenManager: deps.tokenManager,
  });
  app.route('/oauth', oauthRoutes);

  // Mount login routes (email + password)
  const loginRoutes = createLoginRoutes({
    store: deps.store,
  });
  app.route('/auth', loginRoutes);

  // Mount GUI routes (must be last — catches '/')
  const guiRoutes = createGuiRoutes({
    store: deps.store,
    connectorRegistry: deps.connectorRegistry,
    config: deps.config,
    tokenManager: deps.tokenManager,
  });
  app.route('/', guiRoutes);

  return app;
}

export function startServer(deps: ServerDeps): void {
  const app = createServer(deps);
  const port = deps.config.port ?? 3000;

  serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port,
  });

  console.log(`PersonalDataHub server listening on http://127.0.0.1:${port}`);
}
