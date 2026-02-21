export interface CacheConfig {
  enabled: boolean;
  sync_interval?: string;
  ttl?: string;
  encrypt?: boolean;
}

export interface OwnerAuth {
  type: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface AgentIdentity {
  type: string;
  email?: string;
  github_username?: string;
  permissions?: string[];
  repos?: Array<{
    repo: string;
    permissions: string[];
  }>;
}

export interface SourceBoundary {
  after?: string;
  labels?: string[];
  exclude_labels?: string[];
  repos?: string[];
  types?: string[];
}

export interface SourceConfig {
  enabled: boolean;
  owner_auth: OwnerAuth;
  agent_identity?: AgentIdentity;
  boundary: SourceBoundary;
  cache?: CacheConfig;
}

export interface HubConfig {
  sources: Record<string, SourceConfig>;
  encryption_key?: string;
  port?: number;
}
