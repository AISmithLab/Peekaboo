import { describe, it, expect } from 'vitest';
import { GitHubConnector } from './connector.js';

describe('GitHub Connector', () => {
  it('validateAccess returns true for repos in boundary', () => {
    const connector = new GitHubConnector({
      ownerToken: 'fake-token',
      agentUsername: 'my-ai-agent',
      allowedRepos: ['myorg/frontend', 'myorg/api-server'],
    });

    expect(connector.validateAccess('myorg/frontend')).toBe(true);
    expect(connector.validateAccess('myorg/api-server')).toBe(true);
  });

  it('validateAccess returns false for repos not in boundary', () => {
    const connector = new GitHubConnector({
      ownerToken: 'fake-token',
      agentUsername: 'my-ai-agent',
      allowedRepos: ['myorg/frontend', 'myorg/api-server'],
    });

    expect(connector.validateAccess('myorg/billing')).toBe(false);
    expect(connector.validateAccess('myorg/infra')).toBe(false);
  });

  it('getAccessList returns allowed repos', () => {
    const connector = new GitHubConnector({
      ownerToken: 'fake-token',
      agentUsername: 'my-ai-agent',
      allowedRepos: ['myorg/frontend', 'myorg/api-server', 'personal/dotfiles'],
    });

    const list = connector.getAccessList({});
    expect(list).toEqual(['myorg/frontend', 'myorg/api-server', 'personal/dotfiles']);
  });

  it('executeAction returns failure (actions go through agent credentials)', async () => {
    const connector = new GitHubConnector({
      ownerToken: 'fake-token',
      agentUsername: 'my-ai-agent',
      allowedRepos: ['myorg/frontend'],
    });

    const result = await connector.executeAction('comment_on_issue', { body: 'test' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('directly');
  });

  it('implements SourceConnector interface', () => {
    const connector = new GitHubConnector({
      ownerToken: 'fake-token',
      agentUsername: 'my-ai-agent',
      allowedRepos: [],
    });

    expect(connector.name).toBe('github');
    expect(typeof connector.fetch).toBe('function');
    expect(typeof connector.executeAction).toBe('function');
  });
});
