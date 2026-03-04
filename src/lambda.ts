/**
 * Lambda entry point — thin serverless wrapper.
 *
 * Loads config from environment variables, delegates to createApp()
 * for DataStore creation and gateway setup, then exports a Lambda handler.
 */

import { handle } from 'hono/aws-lambda';
import type { HubConfigParsed } from './config/schema.js';
import { createApp } from './app.js';

function loadConfigFromEnv(): HubConfigParsed {
  const sources: HubConfigParsed['sources'] = {};

  if (process.env.GMAIL_CLIENT_ID) {
    sources.gmail = {
      enabled: true,
      owner_auth: {
        type: 'oauth2',
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
      },
      boundary: {
        after: process.env.GMAIL_BOUNDARY_AFTER ?? '2024-01-01',
      },
    };
  }

  if (process.env.GITHUB_CLIENT_ID) {
    sources.github = {
      enabled: true,
      owner_auth: {
        type: 'oauth2',
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      },
      boundary: {},
      agent_identity: {
        type: 'github',
        github_username: process.env.GITHUB_AGENT_USERNAME ?? '',
      },
    };
  }

  return {
    deployment: {
      gateway: 'serverless',
      database: 'dynamodb',
      base_url: process.env.BASE_URL,
      dynamodb_table: process.env.DYNAMODB_TABLE,
    },
    sources,
    port: 3000,
  };
}

const { app } = await createApp(loadConfigFromEnv());

export const handler = handle(app);
