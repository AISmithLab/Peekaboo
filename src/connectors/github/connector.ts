import { Octokit } from 'octokit';
import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export interface GitHubConnectorConfig {
  ownerToken: string;
  agentUsername: string;
  allowedRepos: string[];
}

export class GitHubConnector implements SourceConnector {
  name = 'github';
  private octokit: Octokit;
  private agentUsername: string;
  private allowedRepos: Set<string>;

  constructor(config: GitHubConnectorConfig) {
    this.octokit = new Octokit({ auth: config.ownerToken });
    this.agentUsername = config.agentUsername;
    this.allowedRepos = new Set(config.allowedRepos);
  }

  /**
   * Update the set of allowed repos without recreating the connector.
   */
  updateAllowedRepos(repos: string[]): void {
    this.allowedRepos = new Set(repos);
  }

  /**
   * Check if a repo is within the allowed boundary.
   */
  validateAccess(repo: string): boolean {
    return this.allowedRepos.has(repo);
  }

  /**
   * Return the list of repos the agent is allowed to access.
   */
  getAccessList(_boundary: SourceBoundary): string[] {
    return Array.from(this.allowedRepos);
  }

  /**
   * Fetch data from GitHub API for allowed repos.
   * In practice, the agent interacts with GitHub directly using its own PAT.
   * This method is provided for consistency but the primary use case is access control.
   */
  async fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]> {
    const repos = boundary.repos ?? Array.from(this.allowedRepos);
    const types = (params?.type as string)?.split(',') ?? boundary.types ?? ['issue', 'pr'];
    const rows: DataRow[] = [];

    for (const repo of repos) {
      if (!this.validateAccess(repo)) continue;

      const [owner, repoName] = repo.split('/');

      if (types.includes('issue')) {
        const issues = await this.fetchIssues(owner, repoName, boundary);
        rows.push(...issues);
      }

      if (types.includes('pr')) {
        const prs = await this.fetchPullRequests(owner, repoName, boundary);
        rows.push(...prs);
      }
    }

    return rows;
  }

  /**
   * GitHub actions go through agent's own credentials — not staged through Hub.
   */
  async executeAction(_actionType: string, _actionData: Record<string, unknown>): Promise<ActionResult> {
    return {
      success: false,
      message: 'GitHub actions should be performed directly with agent credentials, not through PersonalDataHub',
    };
  }

  private async fetchIssues(owner: string, repo: string, boundary: SourceBoundary): Promise<DataRow[]> {
    const params: Record<string, unknown> = {
      owner,
      repo,
      state: 'all' as const,
      per_page: 100,
      sort: 'updated' as const,
      direction: 'desc' as const,
    };

    if (boundary.after) {
      params.since = boundary.after;
    }

    const { data } = await this.octokit.rest.issues.listForRepo(params as Parameters<typeof this.octokit.rest.issues.listForRepo>[0]);

    return data
      .filter((issue) => !issue.pull_request) // Exclude PRs from issues endpoint
      .map((issue) => ({
        source: 'github',
        source_item_id: `${owner}/${repo}#${issue.number}`,
        type: 'issue',
        timestamp: issue.created_at,
        data: {
          title: issue.title,
          body: issue.body ?? '',
          author_name: issue.user?.login ?? '',
          author_url: issue.user?.html_url ?? '',
          labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
          url: issue.html_url,
          repo: `${owner}/${repo}`,
          number: issue.number,
          state: issue.state,
        },
      }));
  }

  private async fetchPullRequests(owner: string, repo: string, boundary: SourceBoundary): Promise<DataRow[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    });

    const filtered = boundary.after
      ? data.filter((pr) => pr.created_at >= boundary.after!)
      : data;

    return filtered.map((pr) => ({
      source: 'github',
      source_item_id: `${owner}/${repo}#${pr.number}`,
      type: 'pr',
      timestamp: pr.created_at,
      data: {
        title: pr.title,
        body: pr.body ?? '',
        author_name: pr.user?.login ?? '',
        author_url: pr.user?.html_url ?? '',
        labels: pr.labels.map((l) => l.name ?? ''),
        url: pr.html_url,
        repo: `${owner}/${repo}`,
        number: pr.number,
        state: pr.state,
        draft: pr.draft ?? false,
      },
    }));
  }
}
