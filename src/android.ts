/**
 * Android entry point — runs inside nodejs-mobile-capacitor's background thread.
 *
 * Node.js Mobile starts this file via the `nodejs-mobile-capacitor` plugin
 * on app launch. It starts the Hono server on port 3000, which the Capacitor
 * WebView then loads via capacitor.config.ts → server.url.
 *
 * Environment:
 *   PDH_MOBILE=true       → selects sql.js DataStore (no native SQLite bindings)
 *   PDH_DB_PATH           → path to the on-device .db file (set automatically)
 *   PDH_CONFIG_PATH       → path to hub-config.yaml on the device
 *   PDH_ENCRYPTION_KEY    → master encryption key (set during first-launch setup)
 */

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { serve } from '@hono/node-server';

// Signal to app.ts to use the sql.js DataStore
process.env.PDH_MOBILE = 'true';

// Resolve the directory containing this file so sql.js can find its WASM binary.
// When bundled by esbuild to CJS, __dirname is defined. In ESM we derive it.
const _dir: string = (typeof __dirname !== 'undefined')
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

// sql-wasm.wasm lives inside the sql.js package that assets:android copies into
// www/nodejs/node_modules/sql.js/dist/ — which lands at _dir/node_modules/sql.js/dist/
if (!process.env.SQLJS_WASM_PATH) {
  process.env.SQLJS_WASM_PATH = join(_dir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
}

// On Android the plugin copies the project to:
//   getFilesDir()/nodejs/public/   ← this is _dir
// App data should live in getFilesDir()/pdh-data/ (two levels up from _dir).
// Fall back to process.cwd()/pdh-data for desktop/CI runs.
const dataDir = process.env.PDH_DATA_DIR ?? join(_dir, '..', '..', 'pdh-data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

process.env.PDH_DB_PATH = join(dataDir, 'pdh.db');

const configPath = process.env.PDH_CONFIG_PATH ?? join(dataDir, 'hub-config.yaml');

// Bootstrap a default config if none exists yet
if (!existsSync(configPath)) {
  const encKey = process.env.PDH_ENCRYPTION_KEY ?? crypto.randomUUID();
  const defaultConfig = `# PersonalDataHub — auto-generated mobile config
deployment:
  database: sqljs

encryption_key: "${encKey}"

sources:
  gmail:
    enabled: true
  google_calendar:
    enabled: true
  github:
    enabled: true

port: 3000
`;
  writeFileSync(configPath, defaultConfig, 'utf8');
  process.env.PDH_ENCRYPTION_KEY = encKey;
}

const port = Number(process.env.PORT ?? 3000);

async function main() {
  const { loadConfig } = await import('./config/loader.js');
  const config = await loadConfig(configPath);

  const { app } = await createApp(config);

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`[PDH Android] Server running on http://127.0.0.1:${port}`);
  });
}

main().catch((err) => {
  console.error('[PDH Android] Fatal startup error:', err);
  process.exit(1);
});
