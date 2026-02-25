import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readConfig } from '../cli.js';

interface SourceStatus {
  connected: boolean;
}

interface SourcesResponse {
  ok: boolean;
  sources: Record<string, SourceStatus>;
}

async function discoverSources(hubUrl: string): Promise<Record<string, SourceStatus>> {
  const res = await fetch(`${hubUrl}/app/v1/sources`);
  if (!res.ok) {
    throw new Error(`Failed to discover sources: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as SourcesResponse;
  if (!body.ok) {
    throw new Error('Failed to discover sources: unexpected response');
  }
  return body.sources;
}

async function checkHealth(hubUrl: string): Promise<void> {
  try {
    const res = await fetch(`${hubUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`PersonalDataHub server not reachable at ${hubUrl} (timeout). Is it running? Try: npx pdh start`);
    }
    throw new Error(`PersonalDataHub server not reachable at ${hubUrl}. Is it running? Try: npx pdh start`);
  }
}

function registerGmailTools(server: McpServer, hubUrl: string): void {
  server.tool(
    'read_emails',
    'Pull emails from Gmail. Data is filtered and redacted according to the owner\'s access control policy.',
    {
      query: z.string().optional().describe('Gmail search query (e.g. "is:unread from:alice newer_than:7d")'),
      limit: z.number().optional().describe('Maximum number of results'),
      purpose: z.string().describe('Why this data is needed (logged for audit)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ query, limit, purpose }) => {
      const body: Record<string, unknown> = { source: 'gmail', purpose };
      if (query) body.query = query;
      if (limit) body.limit = limit;

      const res = await fetch(`${hubUrl}/app/v1/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );

  server.tool(
    'draft_email',
    'Draft an email via Gmail. The draft is staged for the data owner to review — it does NOT send until approved.',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body'),
      in_reply_to: z.string().optional().describe('Message ID for threading'),
      purpose: z.string().describe('Why this action is being proposed (logged for audit)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, in_reply_to, purpose }) => {
      const res = await fetch(`${hubUrl}/app/v1/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'gmail',
          action_type: 'draft_email',
          action_data: { to, subject, body, ...(in_reply_to ? { in_reply_to } : {}) },
          purpose,
        }),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );

  server.tool(
    'send_email',
    'Send an email via Gmail. The action is staged for the data owner to review — it does NOT execute until approved.',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body'),
      in_reply_to: z.string().optional().describe('Message ID for threading'),
      purpose: z.string().describe('Why this action is being proposed (logged for audit)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, in_reply_to, purpose }) => {
      const res = await fetch(`${hubUrl}/app/v1/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'gmail',
          action_type: 'send_email',
          action_data: { to, subject, body, ...(in_reply_to ? { in_reply_to } : {}) },
          purpose,
        }),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );

  server.tool(
    'reply_to_email',
    'Reply to an email via Gmail. The reply is staged for the data owner to review — it does NOT send until approved.',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body'),
      in_reply_to: z.string().describe('Message ID of the email being replied to'),
      purpose: z.string().describe('Why this action is being proposed (logged for audit)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, in_reply_to, purpose }) => {
      const res = await fetch(`${hubUrl}/app/v1/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'gmail',
          action_type: 'reply_email',
          action_data: { to, subject, body, in_reply_to },
          purpose,
        }),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );
}

function registerGitHubTools(server: McpServer, hubUrl: string): void {
  server.tool(
    'search_github_issues',
    'Search GitHub issues. Data is filtered according to the owner\'s access control policy.',
    {
      query: z.string().optional().describe('Search query for issues'),
      limit: z.number().optional().describe('Maximum number of results'),
      purpose: z.string().describe('Why this data is needed (logged for audit)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ query, limit, purpose }) => {
      const body: Record<string, unknown> = { source: 'github', type: 'issue', purpose };
      if (query) body.query = query;
      if (limit) body.limit = limit;

      const res = await fetch(`${hubUrl}/app/v1/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );

  server.tool(
    'search_github_prs',
    'Search GitHub pull requests. Data is filtered according to the owner\'s access control policy.',
    {
      query: z.string().optional().describe('Search query for pull requests'),
      limit: z.number().optional().describe('Maximum number of results'),
      purpose: z.string().describe('Why this data is needed (logged for audit)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ query, limit, purpose }) => {
      const body: Record<string, unknown> = { source: 'github', type: 'pr', purpose };
      if (query) body.query = query;
      if (limit) body.limit = limit;

      const res = await fetch(`${hubUrl}/app/v1/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }] };
    },
  );
}

export async function startMcpServer(): Promise<McpServer> {
  const config = readConfig();
  if (!config) {
    throw new Error(
      'No PersonalDataHub config found at ~/.pdh/config.json. Run "npx pdh init" first.',
    );
  }

  const { hubUrl } = config;

  await checkHealth(hubUrl);

  const sources = await discoverSources(hubUrl);

  const server = new McpServer({
    name: 'PersonalDataHub',
    version: '0.1.0',
  });

  const registeredTools: string[] = [];

  if (sources.gmail?.connected) {
    registerGmailTools(server, hubUrl);
    registeredTools.push('read_emails', 'draft_email', 'send_email', 'reply_to_email');
  }

  if (sources.github?.connected) {
    registerGitHubTools(server, hubUrl);
    registeredTools.push('search_github_issues', 'search_github_prs');
  }

  if (registeredTools.length === 0) {
    console.error('Warning: No connected sources found. Connect sources via the GUI at ' + hubUrl);
  } else {
    console.error(`PersonalDataHub MCP server started with tools: ${registeredTools.join(', ')}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return server;
}
