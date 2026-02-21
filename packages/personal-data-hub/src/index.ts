/**
 * PersonalDataHub — OpenClaw extension for interacting with Peekaboo.
 *
 * Registers tools that let the agent pull personal data and propose
 * outbound actions through the Peekaboo access control gateway.
 *
 * Supports auto-setup: if hubUrl/apiKey are not configured, the extension
 * will try to discover a running Peekaboo hub and create an API key.
 */

import { HubClient } from './hub-client.js';
import { createPullTool, createProposeTool } from './tools.js';
import { PERSONAL_DATA_SYSTEM_PROMPT } from './prompts.js';
import { discoverHub, checkHub, createApiKey } from './setup.js';

export interface PersonalDataHubPluginConfig {
  hubUrl: string;
  apiKey: string;
}

export default {
  id: 'personal-data-hub',
  name: 'Personal Data Hub',
  description: 'Unified interface to personal data through Peekaboo access control gateway',

  configSchema: {
    safeParse(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
          success: false as const,
          error: { issues: [{ path: [], message: 'expected config object' }] },
        };
      }
      const cfg = value as Record<string, unknown>;
      if (!cfg.hubUrl || typeof cfg.hubUrl !== 'string') {
        return {
          success: false as const,
          error: { issues: [{ path: ['hubUrl'], message: 'hubUrl is required and must be a string' }] },
        };
      }
      if (!cfg.apiKey || typeof cfg.apiKey !== 'string') {
        return {
          success: false as const,
          error: { issues: [{ path: ['apiKey'], message: 'apiKey is required and must be a string' }] },
        };
      }
      return { success: true as const, data: value };
    },
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hubUrl: { type: 'string' },
        apiKey: { type: 'string' },
      },
      required: ['hubUrl', 'apiKey'],
    },
  },

  async register(api: {
    pluginConfig?: Record<string, unknown>;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    registerTool: (tool: unknown) => void;
    on: (hook: string, handler: (event: unknown) => Promise<unknown>) => void;
  }) {
    let config = api.pluginConfig as PersonalDataHubPluginConfig | undefined;

    // Auto-setup: try to discover hub and create API key if config is incomplete
    if (!config?.hubUrl || !config?.apiKey) {
      api.logger.info('PersonalDataHub: Config incomplete, attempting auto-setup...');

      try {
        let hubUrl = config?.hubUrl;
        let apiKey = config?.apiKey;

        // If no hubUrl, try to discover a running hub
        if (!hubUrl) {
          hubUrl = await discoverHub() ?? undefined;
          if (hubUrl) {
            api.logger.info(`PersonalDataHub: Discovered hub at ${hubUrl}`);
          }
        }

        // If we have a hubUrl but no apiKey, try to create one
        if (hubUrl && !apiKey) {
          const health = await checkHub(hubUrl);
          if (health.ok) {
            const keyResult = await createApiKey(hubUrl, 'OpenClaw Agent');
            apiKey = keyResult.key;
            api.logger.info(
              `PersonalDataHub: Auto-created API key. Save this for your config: ${apiKey}`,
            );
          }
        }

        if (hubUrl && apiKey) {
          config = { hubUrl, apiKey };
        }
      } catch (err) {
        api.logger.warn(
          `PersonalDataHub: Auto-setup failed: ${(err as Error).message}`,
        );
      }
    }

    if (!config?.hubUrl || !config?.apiKey) {
      api.logger.warn(
        'PersonalDataHub: Missing hubUrl or apiKey. Auto-setup could not find a running hub.\n' +
        '  To set up Peekaboo:\n' +
        '  1. Run: npx peekaboo init\n' +
        '  2. Start the server: node dist/index.js\n' +
        '  3. Restart this extension — it will auto-connect.\n' +
        '  Or configure manually: { "hubUrl": "http://localhost:3000", "apiKey": "pk_..." }',
      );
      return;
    }

    const client = new HubClient({
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
    });

    api.logger.info(`PersonalDataHub: Registering tools (hub: ${config.hubUrl})`);

    // Register the two tools
    api.registerTool(createPullTool(client));
    api.registerTool(createProposeTool(client));

    // Inject system prompt before agent starts
    api.on('before_agent_start', async (_event: unknown) => {
      return { systemPromptAppend: PERSONAL_DATA_SYSTEM_PROMPT };
    });
  },
};

// Re-export for direct usage
export { HubClient, HubApiError } from './hub-client.js';
export type { HubClientConfig, PullParams, ProposeParams, PullResult, ProposeResult } from './hub-client.js';
export { createPullTool, createProposeTool } from './tools.js';
export { PERSONAL_DATA_SYSTEM_PROMPT } from './prompts.js';
export { checkHub, createApiKey, autoSetup, discoverHub } from './setup.js';
