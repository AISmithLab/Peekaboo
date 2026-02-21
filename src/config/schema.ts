import { z } from 'zod';

const cacheSchema = z.object({
  enabled: z.boolean().default(false),
  sync_interval: z.string().optional(),
  ttl: z.string().optional(),
  encrypt: z.boolean().default(true),
});

const ownerAuthSchema = z.object({
  type: z.string(),
  token: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const repoPermissionSchema = z.object({
  repo: z.string(),
  permissions: z.array(z.string()),
});

const agentIdentitySchema = z.object({
  type: z.string(),
  email: z.string().optional(),
  github_username: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  repos: z.array(repoPermissionSchema).optional(),
});

const sourceBoundarySchema = z.object({
  after: z.string().optional(),
  labels: z.array(z.string()).optional(),
  exclude_labels: z.array(z.string()).optional(),
  repos: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
});

const sourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  owner_auth: ownerAuthSchema,
  agent_identity: agentIdentitySchema.optional(),
  boundary: sourceBoundarySchema,
  cache: cacheSchema.optional().default({ enabled: false, encrypt: true }),
});

export const hubConfigSchema = z.object({
  sources: z.record(z.string(), sourceConfigSchema),
  encryption_key: z.string().optional(),
  port: z.number().default(3000),
});

export type HubConfigParsed = z.infer<typeof hubConfigSchema>;
