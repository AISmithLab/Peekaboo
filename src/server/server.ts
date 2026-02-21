import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { createAppApi } from './app-api.js';
import { createGuiRoutes } from '../gui/routes.js';

interface ServerDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  encryptionKey?: string;
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({ ok: true, version: '0.1.0' }));

  // Mount App API
  const appApi = createAppApi(deps);
  app.route('/app/v1', appApi);

  // Mount GUI routes
  const guiRoutes = createGuiRoutes(deps);
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

  console.log(`Peekaboo server listening on http://127.0.0.1:${port}`);
}
