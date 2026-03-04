import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import { startServer } from './gateway/server.js';
import { createApp } from './app.js';

const configPath = process.argv[2] ?? resolve('hub-config.yaml');

if (!existsSync(configPath)) {
  console.log('PersonalDataHub v0.1.0');
  console.log(`\nNo config file found at: ${configPath}`);
  console.log("Run 'npx pdh init' to get started.");
  process.exit(1);
}

const config = loadConfig(configPath);
const { store, connectorRegistry, tokenManager } = await createApp(config);
startServer({ store, connectorRegistry, config, tokenManager });
