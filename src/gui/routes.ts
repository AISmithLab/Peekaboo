import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { AuditLog } from '../audit/log.js';
import { GitHubConnector } from '../connectors/github/connector.js';
import { Octokit } from 'octokit';

interface GuiDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  encryptionKey?: string;
  tokenManager: TokenManager;
}

export function createGuiRoutes(deps: GuiDeps): Hono {
  const app = new Hono();
  const auditLog = new AuditLog(deps.db);

  // Serve the SPA
  app.get('/', (c) => {
    return c.html(getIndexHtml());
  });

  // --- GUI API endpoints ---

  // Get all sources and their status
  app.get('/api/sources', (c) => {
    const sources = Object.entries(deps.config.sources).map(([name, config]) => ({
      name,
      enabled: config.enabled,
      boundary: config.boundary,
      cache: config.cache,
      connected: deps.tokenManager.hasToken(name),
      accountInfo: deps.tokenManager.getAccountInfo(name),
    }));
    return c.json({ ok: true, sources });
  });

  // Get manifests
  app.get('/api/manifests', (c) => {
    const manifests = deps.db
      .prepare('SELECT * FROM manifests ORDER BY updated_at DESC')
      .all();
    return c.json({ ok: true, manifests });
  });

  // Create/update manifest
  app.post('/api/manifests', async (c) => {
    const body = await c.req.json();
    const { id, source, purpose, raw_text } = body;

    deps.db.prepare(`
      INSERT INTO manifests (id, source, purpose, raw_text, status, updated_at)
      VALUES (?, ?, ?, ?, 'active', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        purpose = excluded.purpose,
        raw_text = excluded.raw_text,
        updated_at = excluded.updated_at
    `).run(id, source, purpose, raw_text);

    return c.json({ ok: true, id });
  });

  // Delete manifest
  app.delete('/api/manifests/:id', (c) => {
    const id = c.req.param('id');
    deps.db.prepare('DELETE FROM manifests WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Get API keys
  app.get('/api/keys', (c) => {
    const keys = deps.db
      .prepare('SELECT id, name, allowed_manifests, enabled, created_at FROM api_keys')
      .all();
    return c.json({ ok: true, keys });
  });

  // Generate new API key
  app.post('/api/keys', async (c) => {
    const body = await c.req.json();
    const { name, allowed_manifests } = body;

    const id = name.toLowerCase().replace(/\s+/g, '-');
    const rawKey = `pk_${randomUUID().replace(/-/g, '')}`;
    const keyHash = hashSync(rawKey, 10);

    deps.db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, allowed_manifests) VALUES (?, ?, ?, ?)',
    ).run(id, keyHash, name, JSON.stringify(allowed_manifests ?? ['*']));

    // Return the raw key only once — it won't be shown again
    return c.json({ ok: true, id, key: rawKey });
  });

  // Revoke API key
  app.delete('/api/keys/:id', (c) => {
    const id = c.req.param('id');
    deps.db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Get staging queue
  app.get('/api/staging', (c) => {
    const actions = deps.db
      .prepare("SELECT * FROM staging ORDER BY proposed_at DESC")
      .all();
    return c.json({ ok: true, actions });
  });

  // Approve/reject a staged action
  app.post('/api/staging/:actionId/resolve', async (c) => {
    const actionId = c.req.param('actionId');
    const body = await c.req.json();
    const { decision } = body; // 'approve' or 'reject'

    const action = deps.db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown> | undefined;
    const actionSource = (action?.source as string) || null;

    const status = decision === 'approve' ? 'approved' : 'rejected';
    deps.db.prepare(
      "UPDATE staging SET status = ?, resolved_at = datetime('now') WHERE action_id = ?",
    ).run(status, actionId);

    if (decision === 'approve') {
      auditLog.logActionApproved(actionId, 'owner', actionSource ?? undefined);

      // Execute the action via connector
      if (action) {
        const connector = deps.connectorRegistry.get(action.source as string);
        if (connector) {
          try {
            // Always save as Gmail draft on approve — owner sends manually from Gmail
            const result = await connector.executeAction(
              'draft_email',
              JSON.parse(action.action_data as string),
            );
            deps.db.prepare("UPDATE staging SET status = 'committed' WHERE action_id = ?").run(actionId);
            auditLog.logActionCommitted(actionId, action.source as string, result.success ? 'success' : 'failure');
          } catch (_err) {
            auditLog.logActionCommitted(actionId, action.source as string, 'failure');
          }
        }
      }
    } else {
      auditLog.logActionRejected(actionId, 'owner', actionSource ?? undefined);
    }

    return c.json({ ok: true, status });
  });

  // Get single staging action
  app.get('/api/staging/:actionId', (c) => {
    const actionId = c.req.param('actionId');
    const action = deps.db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown> | undefined;
    if (!action) return c.json({ ok: false, error: 'Not found' }, 404);
    try {
      return c.json({ ok: true, action: { ...action, action_data: JSON.parse(action.action_data as string) } });
    } catch {
      return c.json({ ok: true, action });
    }
  });

  // Edit staging action data (only when pending)
  app.post('/api/staging/:actionId/edit', async (c) => {
    const actionId = c.req.param('actionId');
    const body = await c.req.json();
    const action = deps.db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown> | undefined;
    if (!action) return c.json({ ok: false, error: 'Not found' }, 404);
    if (action.status !== 'pending') return c.json({ ok: false, error: 'Action is not pending' }, 400);
    const existing = JSON.parse(action.action_data as string);
    const merged = { ...existing, ...body.action_data };
    deps.db.prepare('UPDATE staging SET action_data = ? WHERE action_id = ?').run(JSON.stringify(merged), actionId);
    return c.json({ ok: true, action_data: merged });
  });

  // Get audit log
  app.get('/api/audit', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const event = c.req.query('event');
    const source = c.req.query('source');

    const entries = auditLog.getEntries({ event: event ?? undefined, source: source ?? undefined, limit });
    return c.json({ ok: true, entries });
  });

  // --- GitHub repo discovery endpoints ---

  // Fetch all repos from GitHub API, upsert into DB, return with selection state
  app.get('/api/github/repos', async (c) => {
    const storedToken = deps.tokenManager.getToken('github');
    if (!storedToken) {
      return c.json({ ok: false, error: 'GitHub not connected' }, 401);
    }

    try {
      const octokit = new Octokit({ auth: storedToken.access_token });

      // Paginate to get all accessible repos (owned + collaborated)
      const userRepos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        type: 'all',
        sort: 'full_name',
      });

      // Also fetch repos from each org the user belongs to
      const orgs = await octokit.paginate(octokit.rest.orgs.listForAuthenticatedUser, { per_page: 100 });
      const orgRepoLists = await Promise.all(
        orgs.map(org => octokit.paginate(octokit.rest.repos.listForOrg, { org: org.login, per_page: 100, type: 'all' }))
      );

      // Deduplicate by full_name
      const seen = new Set<string>();
      const repos = [...userRepos, ...orgRepoLists.flat()].filter(r => {
        if (seen.has(r.full_name)) return false;
        seen.add(r.full_name);
        return true;
      });

      // Upsert each repo into github_repos, preserving existing enabled/permissions
      const upsert = deps.db.prepare(`
        INSERT INTO github_repos (full_name, owner, name, private, description, is_org, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(full_name) DO UPDATE SET
          private = excluded.private,
          description = excluded.description,
          is_org = excluded.is_org,
          fetched_at = excluded.fetched_at
      `);

      const upsertMany = deps.db.transaction(() => {
        for (const repo of repos) {
          upsert.run(
            repo.full_name,
            repo.owner.login,
            repo.name,
            repo.private ? 1 : 0,
            repo.description ?? '',
            repo.owner.type === 'Organization' ? 1 : 0,
          );
        }
      });
      upsertMany();

      // Return all repos from DB with their selection state
      const allRepos = deps.db.prepare(
        'SELECT * FROM github_repos ORDER BY owner, name',
      ).all() as Array<{
        full_name: string;
        owner: string;
        name: string;
        private: number;
        description: string;
        is_org: number;
        enabled: number;
        permissions: string;
        fetched_at: string;
      }>;

      return c.json({ ok: true, repos: allRepos });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Save user's repo selection and permissions
  app.post('/api/github/repos', async (c) => {
    const body = await c.req.json() as {
      repos: Record<string, { enabled: boolean; permissions: string[] }>;
    };

    if (!body.repos || typeof body.repos !== 'object') {
      return c.json({ ok: false, error: 'Invalid body' }, 400);
    }

    const update = deps.db.prepare(
      'UPDATE github_repos SET enabled = ?, permissions = ? WHERE full_name = ?',
    );

    const updateMany = deps.db.transaction(() => {
      for (const [fullName, settings] of Object.entries(body.repos)) {
        update.run(
          settings.enabled ? 1 : 0,
          JSON.stringify(settings.permissions),
          fullName,
        );
      }
    });
    updateMany();

    // Rebuild allowed repos and update connector
    const enabledRepos = deps.db.prepare(
      "SELECT full_name FROM github_repos WHERE enabled = 1",
    ).all() as Array<{ full_name: string }>;
    const enabledNames = enabledRepos.map((r) => r.full_name);

    const connector = deps.connectorRegistry.get('github');
    if (connector && connector instanceof GitHubConnector) {
      connector.updateAllowedRepos(enabledNames);
    }

    return c.json({ ok: true });
  });

  return app;
}

function getIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Peekaboo - Personal Data Hub</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
    .header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .header .version { font-size: 12px; opacity: 0.6; }
    .tabs { display: flex; background: #16213e; border-bottom: 2px solid #0f3460; }
    .tab { padding: 12px 24px; color: #aaa; cursor: pointer; border: none; background: none; font-size: 14px; transition: all 0.2s; }
    .tab:hover { color: white; background: rgba(255,255,255,0.05); }
    .tab.active { color: white; background: #0f3460; border-bottom: 2px solid #e94560; }
    .content { max-width: 960px; margin: 24px auto; padding: 0 24px; }
    .card { background: white; border-radius: 8px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 16px; margin-bottom: 12px; color: #1a1a2e; }
    .card h3 { font-size: 14px; margin-bottom: 8px; color: #555; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .status.connected { background: #d4edda; color: #155724; }
    .status.disconnected { background: #f8d7da; color: #721c24; }
    .status.pending { background: #fff3cd; color: #856404; }
    .status.approved { background: #d4edda; color: #155724; }
    .status.rejected { background: #f8d7da; color: #721c24; }
    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; }
    .btn-primary { background: #0f3460; color: white; }
    .btn-primary:hover { background: #1a4a8a; }
    .btn-success { background: #28a745; color: white; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px; }
    th { font-weight: 600; color: #555; }
    .toggle { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .toggle input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
    .toggle label { font-size: 13px; cursor: pointer; }
    input[type="text"], input[type="number"], select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; width: 100%; }
    input[type="datetime-local"] { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; width: 100%; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: #555; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .empty { text-align: center; color: #999; padding: 24px; }
    .key-display { background: #f8f9fa; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 8px 0; }
    #app { min-height: 100vh; }
    .section { margin-bottom: 24px; }

    .ac-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .ac-row label { font-size: 13px; white-space: nowrap; }
    .ac-row input[type="datetime-local"] { width: auto; flex: 1; max-width: 220px; }
    .ac-row input[type="text"] { flex: 1; }
    .checkbox-group { display: flex; flex-wrap: wrap; gap: 2px 14px; }
    .checkbox-group .toggle { margin: 2px 0; position: relative; }
    .checkbox-group .toggle label { border-bottom: 1px dotted #bbb; }
    .checkbox-group .toggle label:hover::after { content: attr(data-tip); position: absolute; left: 0; top: 100%; margin-top: 4px; background: #333; color: #fff; font-size: 11px; padding: 4px 8px; border-radius: 4px; white-space: nowrap; z-index: 10; pointer-events: none; }
    .filter-panel { margin-left: 26px; margin-bottom: 10px; border: 1px solid #e9ecef; border-radius: 6px; padding: 14px 16px; display: none; }
    .filter-panel.show { display: block; }
    .filter-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .filter-row:last-child { margin-bottom: 0; }
    .filter-label { font-size: 13px; color: #333; min-width: 110px; }
    .filter-row input[type="text"] { flex: 1; border: 1px solid #ddd; border-radius: 4px; padding: 6px 10px; font-size: 13px; outline: none; }
    .filter-row input[type="text"]:focus { border-color: #0f3460; }
    .filter-row input[type="date"] { border: 1px solid #ddd; border-radius: 4px; padding: 6px 10px; font-size: 13px; outline: none; flex: 1; }
    .filter-row select { border: 1px solid #ddd; border-radius: 4px; padding: 6px 10px; background: white; font-size: 13px; outline: none; }
    .filter-row input[type="number"] { width: 100px; border: 1px solid #ddd; border-radius: 4px; padding: 6px 10px; font-size: 13px; outline: none; }
    .expand-link { font-size: 12px; color: #0f3460; cursor: pointer; text-decoration: none; margin-left: 4px; }
    .expand-link:hover { text-decoration: underline; }
    .sel-links { font-size: 11px; margin-left: 4px; }
    .sel-links a { color: #0f3460; text-decoration: none; cursor: pointer; }
    .sel-links a:hover { text-decoration: underline; }

    .repo-item { border: 1px solid #e9ecef; border-radius: 6px; margin-bottom: 8px; }
    .repo-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; background: #fafafa; transition: background 0.15s; }
    .repo-header:hover { background: #f0f0f0; }
    .repo-name { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 13px; flex: 1; }
    .repo-chevron { font-size: 12px; color: #888; transition: transform 0.2s; }
    .repo-chevron.open { transform: rotate(90deg); }
    .repo-perms { padding: 12px 14px 4px; border-top: 1px solid #e9ecef; display: none; }
    .repo-perms.show { display: block; }
    .perm-grid { display: flex; gap: 24px; }
    .perm-col h4 { font-size: 12px; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; letter-spacing: 0.3px; }

    .save-flash { display: inline-block; margin-left: 10px; font-size: 12px; font-weight: 600; color: #155724; opacity: 0; transition: opacity 0.3s; }
    .save-flash.show { opacity: 1; }
    .email-card { border: 1px solid #e2e5e9; border-radius: 10px; margin-bottom: 14px; overflow: hidden; background: #fff; transition: box-shadow 0.2s; }
    .email-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.07); }
    .email-card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eef0f2; }
    .email-card-title { font-size: 14px; font-weight: 600; color: #1a1a2e; }
    .email-card-meta { padding: 12px 18px 0; }
    .email-field { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 13px; }
    .email-field-label { font-weight: 600; color: #8a8f98; min-width: 55px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
    .email-card-body { padding: 10px 18px 14px; }
    .email-body-display { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; font-size: 13px; line-height: 1.55; margin: 0; background: #f8f9fb; border: none; border-radius: 6px; padding: 12px 14px; color: #333; }
    .email-card-actions { display: flex; gap: 8px; padding: 0 18px 14px; justify-content: flex-end; }
    .email-card-actions .btn { border-radius: 6px; font-weight: 500; font-size: 13px; padding: 7px 16px; transition: all 0.15s; }
    .email-card-actions .btn-approve { background: #22c55e; color: white; border: none; }
    .email-card-actions .btn-approve:hover { background: #16a34a; }
    .email-card-actions .btn-deny { background: #fff; color: #dc2626; border: 1px solid #fca5a5; }
    .email-card-actions .btn-deny:hover { background: #fef2f2; border-color: #dc2626; }
    .email-card-actions .btn-edit { background: #fff; color: #555; border: 1px solid #ddd; }
    .email-card-actions .btn-edit:hover { background: #f5f5f5; border-color: #bbb; }
    .email-edit-input { padding: 5px 10px; border: 1px solid #d0d5dd; border-radius: 6px; font-size: 13px; flex: 1; outline: none; transition: border 0.15s; }
    .email-edit-input:focus { border-color: #0f3460; }
    .email-body-edit { width: 100%; min-height: 120px; padding: 10px 12px; border: 1px solid #d0d5dd; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; outline: none; transition: border 0.15s; line-height: 1.55; }
    .email-body-edit:focus { border-color: #0f3460; }
    .resolved-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
    .resolved-row:last-child { border-bottom: none; }
    .tab-badge { background: #e94560; color: white; font-size: 11px; border-radius: 10px; padding: 1px 6px; margin-left: 4px; }
    .btn-outline { background: white; color: #333; border: 1px solid #ddd; }
    .btn-outline:hover { background: #f0f0f0; }
    .status.committed { background: #d4edda; color: #155724; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ddd; border-top-color: #0f3460; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="app">
    <div class="header">
      <h1>Peekaboo</h1>
      <span class="version">v0.1.0</span>
    </div>
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="gmail">Gmail</button>
      <button class="tab" data-tab="github">GitHub</button>
      <button class="tab" data-tab="settings">Settings</button>
    </div>
    <div class="content" id="content"></div>
  </div>

  <script>
    let currentTab = 'gmail';
    let state = {
      sources: [], manifests: [], keys: [], staging: [], audit: [],
      gmail: {
        timeEnabled: false, after: '',
        fieldsEnabled: false, fields: { subject: true, body: true, sender: true, participants: true, labels: true, attachments: false, snippet: false },
        filterEnabled: false, filterOpen: false,
        filter: { from: '', to: '', subject: '', hasWords: '', notWords: '', sizeOp: 'greater', sizeVal: '', sizeUnit: 'MB', dateRange: '1 day', dateVal: '', searchIn: 'All Mail', hasAttachment: false },
      },
      github: { repos: {}, repoList: [], reposLoading: false, reposLoaded: false, filterOwner: '', search: '' },
      expandedRepos: {},
    };
    let _saveTimer = null;

    // Tab switching
    document.getElementById('tabs').addEventListener('click', (e) => {
      if (e.target.classList.contains('tab')) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        currentTab = e.target.dataset.tab;
        render();
      }
    });

    async function fetchData() {
      const [sources, manifests, keys, staging, audit] = await Promise.all([
        fetch('/api/sources').then(r => r.json()),
        fetch('/api/manifests').then(r => r.json()),
        fetch('/api/keys').then(r => r.json()),
        fetch('/api/staging').then(r => r.json()),
        fetch('/api/audit?limit=20').then(r => r.json()),
      ]);
      state.sources = sources.sources || [];
      state.manifests = manifests.manifests || [];
      state.keys = keys.keys || [];
      state.staging = staging.actions || [];
      state.audit = audit.entries || [];

      // Seed gmail time boundary from config
      const gm = state.sources.find(s => s.name === 'gmail');
      if (gm && gm.boundary && gm.boundary.after && !state.gmail.after) {
        state.gmail.after = gm.boundary.after;
      }

      render();
    }

    function render() {
      var focused = document.activeElement;
      var focusId = focused && focused.id ? focused.id : null;
      var cursorPos = focused && focused.selectionStart != null ? focused.selectionStart : null;

      const content = document.getElementById('content');
      switch (currentTab) {
        case 'gmail': content.innerHTML = renderGmailTab(); break;
        case 'github': content.innerHTML = renderGitHubTab(); break;
        case 'settings': content.innerHTML = renderSettingsTab(); break;
      }
      var gmailPendingCount = state.staging.filter(function(a) { return a.source === 'gmail' && a.status === 'pending'; }).length;
      var gmailTabEl = document.querySelector('.tab[data-tab="gmail"]');
      if (gmailTabEl) gmailTabEl.innerHTML = gmailPendingCount ? 'Gmail <span class="tab-badge">' + gmailPendingCount + '</span>' : 'Gmail';

      if (focusId) {
        var el = document.getElementById(focusId);
        if (el) { el.focus(); if (cursorPos != null && el.setSelectionRange) el.setSelectionRange(cursorPos, cursorPos); }
      }
    }

    function chk(v) { return v ? 'checked' : ''; }

    function renderGmailTab() {
      const gmail = state.sources.find(s => s.name === 'gmail');
      const s = state.gmail;
      const gmailStaging = state.staging.filter(a => a.source === 'gmail');
      const pendingCount = gmailStaging.filter(a => a.status === 'pending').length;
      const gmailAudit = state.audit.filter(e => {
        const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
        return e.source === 'gmail' || d.source === 'gmail';
      });

      var gmailConnected = gmail && gmail.connected;
      var gmailAccount = gmail && gmail.accountInfo;

      return \`
        <div class="card">
          <h2>Connection Status</h2>
          \${gmailConnected
            ? '<p>Status: <span class="status connected">Connected</span></p>' +
              (gmailAccount && gmailAccount.email ? '<p style="margin-top:8px">Signed in as <strong>' + gmailAccount.email + '</strong></p>' : '') +
              '<div class="actions"><button class="btn btn-danger" onclick="disconnectSource(\\'gmail\\')">Disconnect Gmail</button></div>'
            : '<p>Status: <span class="status disconnected">' + (gmail?.enabled ? 'Not connected' : 'Not configured') + '</span></p>' +
              '<div class="actions"><button class="btn btn-primary" onclick="startOAuth(\\'gmail\\')">Connect Gmail</button></div>'
          }
        </div>

        <div class="card">
          <h2>Access Control <span class="save-flash" id="gmail-flash">Saved</span></h2>

          <div class="ac-row">
            <input type="checkbox" id="ac-time" \${chk(s.timeEnabled)} onchange="state.gmail.timeEnabled = this.checked; saveGmail()">
            <label for="ac-time">Only access emails after</label>
            <input type="datetime-local" value="\${s.after || ''}" onchange="state.gmail.after = this.value; if(!state.gmail.timeEnabled){state.gmail.timeEnabled=true;} saveGmail()">
          </div>

          <div class="ac-row">
            <input type="checkbox" id="ac-fields" \${chk(s.fieldsEnabled)} onchange="state.gmail.fieldsEnabled = this.checked; saveGmail()">
            <label for="ac-fields">Agents can only see</label>
            <span class="sel-links">(<a onclick="setAllFields(true)">all</a> / <a onclick="setAllFields(false)">none</a>)</span>
          </div>
          <div class="checkbox-group" style="margin-left:26px;margin-bottom:10px">
            <div class="toggle"><input type="checkbox" id="f-subject" \${chk(s.fields.subject)} onchange="state.gmail.fields.subject = this.checked; saveGmail()"><label for="f-subject" data-tip="Email subject line">Subject</label></div>
            <div class="toggle"><input type="checkbox" id="f-body" \${chk(s.fields.body)} onchange="state.gmail.fields.body = this.checked; saveGmail()"><label for="f-body" data-tip="Full email body content">Body</label></div>
            <div class="toggle"><input type="checkbox" id="f-sender" \${chk(s.fields.sender)} onchange="state.gmail.fields.sender = this.checked; saveGmail()"><label for="f-sender" data-tip="Sender name and email address">Sender</label></div>
            <div class="toggle"><input type="checkbox" id="f-participants" \${chk(s.fields.participants)} onchange="state.gmail.fields.participants = this.checked; saveGmail()"><label for="f-participants" data-tip="To, CC, and BCC recipients">Recipients</label></div>
            <div class="toggle"><input type="checkbox" id="f-labels" \${chk(s.fields.labels)} onchange="state.gmail.fields.labels = this.checked; saveGmail()"><label for="f-labels" data-tip="Gmail labels and categories">Labels</label></div>
            <div class="toggle"><input type="checkbox" id="f-attachments" \${chk(s.fields.attachments)} onchange="state.gmail.fields.attachments = this.checked; saveGmail()"><label for="f-attachments" data-tip="Attachment file names and metadata">Attachments</label></div>
            <div class="toggle"><input type="checkbox" id="f-snippet" \${chk(s.fields.snippet)} onchange="state.gmail.fields.snippet = this.checked; saveGmail()"><label for="f-snippet" data-tip="Short preview text from Gmail">Snippet</label></div>
          </div>

          <div class="ac-row">
            <input type="checkbox" id="ac-filter" \${chk(s.filterEnabled)} onchange="state.gmail.filterEnabled = this.checked; state.gmail.filterOpen = this.checked; render(); saveGmail()">
            <label for="ac-filter">Advanced email filter</label>
          </div>
          <div class="filter-panel \${s.filterOpen ? 'show' : ''}">
            <div class="filter-row"><span class="filter-label">From</span><input type="text" value="\${s.filter.from}" oninput="state.gmail.filter.from=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">To</span><input type="text" value="\${s.filter.to}" oninput="state.gmail.filter.to=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">Subject</span><input type="text" value="\${s.filter.subject}" oninput="state.gmail.filter.subject=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">Has the words</span><input type="text" value="\${s.filter.hasWords}" oninput="state.gmail.filter.hasWords=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">Doesn't have</span><input type="text" value="\${s.filter.notWords}" oninput="state.gmail.filter.notWords=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">Size</span><select onchange="state.gmail.filter.sizeOp=this.value; saveGmail()"><option value="greater" \${s.filter.sizeOp==='greater'?'selected':''}>greater than</option><option value="less" \${s.filter.sizeOp==='less'?'selected':''}>less than</option></select><input type="number" value="\${s.filter.sizeVal}" min="0" oninput="state.gmail.filter.sizeVal=this.value; saveGmail()"><select onchange="state.gmail.filter.sizeUnit=this.value; saveGmail()"><option value="MB" \${s.filter.sizeUnit==='MB'?'selected':''}>MB</option><option value="KB" \${s.filter.sizeUnit==='KB'?'selected':''}>KB</option><option value="Bytes" \${s.filter.sizeUnit==='Bytes'?'selected':''}>Bytes</option></select></div>
            <div class="filter-row"><span class="filter-label">Date within</span><select onchange="state.gmail.filter.dateRange=this.value; saveGmail()"><option value="1 day" \${s.filter.dateRange==='1 day'?'selected':''}>1 day</option><option value="3 days" \${s.filter.dateRange==='3 days'?'selected':''}>3 days</option><option value="1 week" \${s.filter.dateRange==='1 week'?'selected':''}>1 week</option><option value="2 weeks" \${s.filter.dateRange==='2 weeks'?'selected':''}>2 weeks</option><option value="1 month" \${s.filter.dateRange==='1 month'?'selected':''}>1 month</option><option value="2 months" \${s.filter.dateRange==='2 months'?'selected':''}>2 months</option><option value="6 months" \${s.filter.dateRange==='6 months'?'selected':''}>6 months</option><option value="1 year" \${s.filter.dateRange==='1 year'?'selected':''}>1 year</option></select><input type="date" value="\${s.filter.dateVal || (s.after ? s.after.split('T')[0] : '')}" onchange="state.gmail.filter.dateVal=this.value; saveGmail()"></div>
            <div class="filter-row"><span class="filter-label">Search</span><select onchange="state.gmail.filter.searchIn=this.value; saveGmail()"><option \${s.filter.searchIn==='All Mail'?'selected':''}>All Mail</option><option \${s.filter.searchIn==='Inbox'?'selected':''}>Inbox</option><option \${s.filter.searchIn==='Starred'?'selected':''}>Starred</option><option \${s.filter.searchIn==='Sent Mail'?'selected':''}>Sent Mail</option><option \${s.filter.searchIn==='Drafts'?'selected':''}>Drafts</option><option \${s.filter.searchIn==='Chats'?'selected':''}>Chats</option><option \${s.filter.searchIn==='Spam'?'selected':''}>Spam</option><option \${s.filter.searchIn==='Trash'?'selected':''}>Trash</option><option \${s.filter.searchIn==='Read Mail'?'selected':''}>Read Mail</option><option \${s.filter.searchIn==='Unread Mail'?'selected':''}>Unread Mail</option></select></div>
            <div class="filter-row"><span class="filter-label"></span><div class="toggle"><input type="checkbox" id="f-hasatt" \${chk(s.filter.hasAttachment)} onchange="state.gmail.filter.hasAttachment=this.checked; saveGmail()"><label for="f-hasatt">Has attachment</label></div></div>
            <div style="margin-top:12px; text-align:right;"><button class="btn btn-primary" onclick="saveGmail()">Create filter</button></div>
          </div>
        </div>

        <div class="card">
          <h2>Pending Actions \${pendingCount ? '<span style="font-size:13px;color:#888;font-weight:400">(' + pendingCount + ')</span>' : ''}</h2>
          \${renderPendingCards(gmailStaging)}
        </div>

        <div class="card">
          <h2>Recent Activity</h2>
          \${gmailAudit.length ? '<table><tr><th>Time</th><th>Event</th><th>Details</th></tr>' +
            gmailAudit.slice(0, 10).map(e => {
              const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
              return '<tr><td style="font-size:11px">' + new Date(e.timestamp).toLocaleString() + '</td><td>' + e.event + '</td><td style="font-size:12px">' + (d.purpose || d.result || JSON.stringify(d).slice(0,80)) + '</td></tr>';
            }).join('') +
            '</table>' : '<p class="empty">No recent activity.</p>'}
        </div>
      \`;
    }

    function renderGitHubTab() {
      const github = state.sources.find(s => s.name === 'github');
      var ghConnected = github && github.connected;
      var ghAccount = github && github.accountInfo;
      var allRepos = state.github.repoList || [];

      // Auto-fetch repos on first render when connected
      if (ghConnected && !state.github.reposLoaded && !state.github.reposLoading) {
        fetchGithubRepos();
      }

      // Collect all unique owners for the dropdown
      var allOwners = [];
      var ownerSeen = {};
      allRepos.forEach(function(r) {
        if (!ownerSeen[r.owner]) { ownerSeen[r.owner] = true; allOwners.push({ name: r.owner, is_org: r.is_org }); }
      });
      allOwners.sort(function(a, b) {
        if (a.is_org !== b.is_org) return a.is_org ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      // Filter repos by owner and search
      var filtered = allRepos;
      if (state.github.filterOwner) {
        filtered = filtered.filter(function(r) { return r.owner === state.github.filterOwner; });
      }
      if (state.github.search) {
        var q = state.github.search.toLowerCase();
        filtered = filtered.filter(function(r) {
          return r.full_name.toLowerCase().indexOf(q) !== -1 || (r.description && r.description.toLowerCase().indexOf(q) !== -1);
        });
      }

      // Group filtered repos by owner
      var groups = {};
      filtered.forEach(function(r) {
        if (!groups[r.owner]) groups[r.owner] = [];
        groups[r.owner].push(r);
      });
      var ownerKeys = Object.keys(groups).sort();
      ownerKeys.sort(function(a, b) {
        var aIsOrg = groups[a][0].is_org;
        var bIsOrg = groups[b][0].is_org;
        if (aIsOrg !== bIsOrg) return aIsOrg ? 1 : -1;
        return a.localeCompare(b);
      });

      var repoHtml = '';
      if (state.github.reposLoading) {
        repoHtml = '<p class="empty" style="display:flex;align-items:center;justify-content:center;gap:8px"><span class="spinner"></span> Loading repositories from GitHub...</p>';
      } else if (ghConnected && !allRepos.length) {
        repoHtml = '<p class="empty">No repositories found. Click "Refresh repos" to fetch.</p>';
      } else if (ghConnected && !filtered.length) {
        repoHtml = '<p class="empty">No repositories match your filter.</p>';
      } else if (ghConnected) {
        ownerKeys.forEach(function(owner) {
          var ownerRepos = groups[owner];
          var isOrg = ownerRepos[0].is_org;
          var enabledCount = ownerRepos.filter(function(r) { return r.enabled; }).length;
          repoHtml += '<div style="margin-bottom:16px">';
          repoHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
          repoHtml += '<h3 style="font-size:14px;margin:0">' + escapeHtml(owner) + '</h3>';
          repoHtml += '<span class="status ' + (isOrg ? 'pending' : 'connected') + '">' + (isOrg ? 'org' : 'personal') + '</span>';
          repoHtml += '<span style="font-size:12px;color:#888">' + enabledCount + '/' + ownerRepos.length + ' selected</span>';
          repoHtml += '<span class="sel-links">(<a onclick="selectAllOwner(\\'' + escapeAttr(owner) + '\\', true)">all</a> / <a onclick="selectAllOwner(\\'' + escapeAttr(owner) + '\\', false)">none</a>)</span>';
          repoHtml += '</div>';

          ownerRepos.forEach(function(repo) {
            var perms = typeof repo.permissions === 'string' ? JSON.parse(repo.permissions) : repo.permissions;
            var hasCodeRead = perms.indexOf('contents:read') !== -1;
            var hasCodeWrite = perms.indexOf('contents:write') !== -1;
            var hasIssuesRead = perms.indexOf('issues:read') !== -1;
            var hasIssuesWrite = perms.indexOf('issues:write') !== -1;
            var hasPrsRead = perms.indexOf('pull_requests:read') !== -1;
            var hasPrsWrite = perms.indexOf('pull_requests:write') !== -1;
            var exp = state.expandedRepos[repo.full_name];
            var safe = repo.full_name.replace(/'/g, "\\\\'");
            repoHtml += '<div class="repo-item">';
            repoHtml += '<div class="repo-header" onclick="toggleRepo(\\'' + safe + '\\')">';
            repoHtml += '<input type="checkbox" ' + chk(repo.enabled) + ' onclick="event.stopPropagation(); toggleRepoEnabled(\\'' + safe + '\\', this.checked)" title="Enable access">';
            repoHtml += '<span class="repo-name">' + escapeHtml(repo.name) + '</span>';
            if (repo.private) repoHtml += '<span class="status disconnected" style="font-size:10px;padding:2px 6px">private</span>';
            if (repo.description) repoHtml += '<span style="font-size:12px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px">' + escapeHtml(repo.description) + '</span>';
            repoHtml += '<span class="repo-chevron ' + (exp ? 'open' : '') + '">&#9654;</span>';
            repoHtml += '</div>';
            repoHtml += '<div class="repo-perms ' + (exp ? 'show' : '') + '">';
            repoHtml += '<div style="display:flex;align-items:center;gap:6px;padding:8px 0">';
            repoHtml += '<span style="font-size:12px;font-weight:700;color:#1a1a2e">Contents</span>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasCodeRead) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'contents:read\\', this.checked)"><label>read</label></div>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasCodeWrite) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'contents:write\\', this.checked)"><label>write</label></div>';
            repoHtml += '<span style="color:#ddd;margin:0 4px">|</span>';
            repoHtml += '<span style="font-size:12px;font-weight:700;color:#1a1a2e">Issues</span>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasIssuesRead) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'issues:read\\', this.checked)"><label>read</label></div>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasIssuesWrite) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'issues:write\\', this.checked)"><label>write</label></div>';
            repoHtml += '<span style="color:#ddd;margin:0 4px">|</span>';
            repoHtml += '<span style="font-size:12px;font-weight:700;color:#1a1a2e">Pull Requests</span>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasPrsRead) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'pull_requests:read\\', this.checked)"><label>read</label></div>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasPrsWrite) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'pull_requests:write\\', this.checked)"><label>write</label></div>';
            repoHtml += '</div></div></div>';
          });
          repoHtml += '</div>';
        });
      }

      // Build owner select options
      var ownerOptions = '<option value="">All accounts</option>';
      allOwners.forEach(function(o) {
        ownerOptions += '<option value="' + escapeAttr(o.name) + '"' + (state.github.filterOwner === o.name ? ' selected' : '') + '>' + escapeHtml(o.name) + (o.is_org ? ' (org)' : '') + '</option>';
      });

      return \`
        <div class="card">
          <h2>Connection Status</h2>
          \${ghConnected
            ? '<p>Status: <span class="status connected">Connected</span></p>' +
              (ghAccount && ghAccount.login ? '<p style="margin-top:8px">Signed in as <strong>@' + ghAccount.login + '</strong></p>' : '') +
              '<div class="actions"><button class="btn btn-danger" onclick="disconnectSource(\\'github\\')">Disconnect GitHub</button></div>'
            : '<p>Status: <span class="status disconnected">' + (github?.enabled ? 'Not connected' : 'Not configured') + '</span></p>' +
              '<div class="actions"><button class="btn btn-primary" onclick="startOAuth(\\'github\\')">Connect GitHub</button></div>'
          }
        </div>

        \${ghConnected ? '<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Repositories <span class="save-flash" id="github-flash">Saved</span></h2><button class="btn btn-outline" onclick="fetchGithubRepos()">Refresh repos</button></div>' +
          '<div style="display:flex;align-items:center;gap:6px;padding:10px 14px;background:#f8f9fa;border-radius:6px;margin-bottom:12px">' +
            '<span style="font-size:12px;font-weight:700;color:#1a1a2e;white-space:nowrap">Contents</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-code-read" checked><label for="bulk-code-read" style="font-size:12px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-code-write"><label for="bulk-code-write" style="font-size:12px">write</label></div>' +
            '<span style="color:#ddd;margin:0 4px">|</span>' +
            '<span style="font-size:12px;font-weight:700;color:#1a1a2e;white-space:nowrap">Issues</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-issues-read" checked><label for="bulk-issues-read" style="font-size:12px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-issues-write"><label for="bulk-issues-write" style="font-size:12px">write</label></div>' +
            '<span style="color:#ddd;margin:0 4px">|</span>' +
            '<span style="font-size:12px;font-weight:700;color:#1a1a2e;white-space:nowrap">Pull Requests</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-prs-read" checked><label for="bulk-prs-read" style="font-size:12px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-prs-write"><label for="bulk-prs-write" style="font-size:12px">write</label></div>' +
            '<span style="flex:1"></span>' +
            '<button class="btn btn-primary btn-sm" onclick="applyBulkPerms()">Apply to selected</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<select style="width:auto;min-width:140px" onchange="state.github.filterOwner=this.value; render()">' + ownerOptions + '</select>' +
            '<input type="text" id="gh-repo-search" placeholder="Search repos..." value="' + escapeAttr(state.github.search) + '" oninput="state.github.search=this.value; render()" style="flex:1">' +
          '</div>' +
          repoHtml + '</div>' : ''}
      \`;
    }

    function renderSettingsTab() {
      return \`
        <div class="card">
          <h2>API Keys</h2>
          \${state.keys.length ? '<table><tr><th>ID</th><th>Name</th><th>Manifests</th><th>Status</th><th>Actions</th></tr>' +
            state.keys.map(k => '<tr><td>' + k.id + '</td><td>' + k.name + '</td><td style="font-size:11px">' + k.allowed_manifests + '</td><td><span class="status ' + (k.enabled ? 'connected' : 'disconnected') + '">' + (k.enabled ? 'Active' : 'Revoked') + '</span></td><td>' +
              (k.enabled ? '<button class="btn btn-danger btn-sm" onclick="revokeKey(\\'' + k.id + '\\')">Revoke</button>' : '') +
              '</td></tr>').join('') +
            '</table>' : '<p class="empty">No API keys.</p>'}
          <div style="margin-top:16px">
            <h3>Generate New Key</h3>
            <div class="form-group">
              <label>App Name</label>
              <input type="text" id="newKeyName" placeholder="e.g., OpenClaw Agent">
            </div>
            <button class="btn btn-primary" onclick="generateKey()">Generate Key</button>
            <div id="newKeyResult"></div>
          </div>
        </div>

        <div class="card">
          <h2>Audit Log</h2>
          \${state.audit.length ? '<table><tr><th>Time</th><th>Event</th><th>Source</th><th>Details</th></tr>' +
            state.audit.map(e => {
              const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
              return '<tr><td style="font-size:11px">' + new Date(e.timestamp).toLocaleString() + '</td><td>' + e.event + '</td><td>' + (e.source || '-') + '</td><td style="font-size:11px">' + JSON.stringify(d).slice(0,100) + '</td></tr>';
            }).join('') +
            '</table>' : '<p class="empty">No audit entries.</p>'}
        </div>
      \`;
    }

    function setAllFields(val) {
      for (var k in state.gmail.fields) state.gmail.fields[k] = val;
      if (!state.gmail.fieldsEnabled) state.gmail.fieldsEnabled = true;
      saveGmail();
      render();
    }

    // --- Toggle repo expand/collapse ---
    function toggleRepo(repo) {
      state.expandedRepos[repo] = !state.expandedRepos[repo];
      render();
    }

    // --- Generate manifest from Gmail settings and save ---
    function buildGmailManifest() {
      var s = state.gmail;
      var fields = [];
      var fieldMap = { subject: ['title'], body: ['body'], sender: ['author_name','author_email'], participants: ['participants'], labels: ['labels'], attachments: ['attachments'], snippet: ['snippet'] };
      for (var k in s.fields) { if (s.fields[k] && fieldMap[k]) fields = fields.concat(fieldMap[k]); }
      fields.push('url', 'timestamp');

      var allOn = Object.values(s.fields).every(Boolean);
      var ops = [], graph = [];

      var pullProps = 'source: "gmail", type: "email"';
      if (s.filterEnabled) {
        var q = [];
        if (s.filter.from) q.push('from:' + s.filter.from);
        if (s.filter.to) q.push('to:' + s.filter.to);
        if (s.filter.subject) q.push('subject:' + s.filter.subject);
        if (s.filter.hasWords) q.push(s.filter.hasWords);
        if (s.filter.notWords) q.push('-{' + s.filter.notWords + '}');
        if (s.filter.sizeVal) q.push((s.filter.sizeOp === 'greater' ? 'larger:' : 'smaller:') + s.filter.sizeVal + s.filter.sizeUnit);
        if (s.filter.dateVal) q.push('after:' + s.filter.dateVal.replace(/-/g, '/'));
        if (s.filter.hasAttachment) q.push('has:attachment');
        if (q.length) pullProps += ', query: "' + q.join(' ').replace(/"/g, '\\\\"') + '"';
      }
      ops.push('pull_emails: pull { ' + pullProps + ' }');
      graph.push('pull_emails');

      if (s.fieldsEnabled && !allOn) {
        ops.push('select_fields: select { fields: [' + fields.map(function(f){ return '"'+f+'"'; }).join(', ') + '] }');
        graph.push('select_fields');
      }

      var checkedNames = Object.keys(s.fields).filter(function(k){ return s.fields[k]; }).join(', ');
      return '@purpose: "Gmail access: ' + checkedNames + '"\\n@graph: ' + graph.join(' -> ') + '\\n' + ops.join('\\n');
    }

    function saveGmail() {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(function() {
        var raw = buildGmailManifest();
        fetch('/api/manifests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'gmail-access-control', source: 'gmail', purpose: 'Auto-generated from access control', raw_text: raw })
        }).then(function() { flash('gmail-flash'); });
      }, 500);
    }

    function buildGithubManifest() {
      var enabled = state.github.repoList.filter(function(r) { return r.enabled; }).map(function(r) { return r.full_name; });
      var purpose = enabled.length ? 'GitHub access: ' + enabled.join(', ') : 'GitHub access: none';
      return '@purpose: "' + purpose + '"\\n@graph: pull_repos\\npull_repos: pull { source: "github", type: "repo" }';
    }

    function saveGithub() {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(function() {
        // Build payload from repoList
        var payload = {};
        state.github.repoList.forEach(function(r) {
          payload[r.full_name] = {
            enabled: !!r.enabled,
            permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions
          };
        });
        fetch('/api/github/repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repos: payload })
        }).then(function() {
          // Also save manifest
          var raw = buildGithubManifest();
          return fetch('/api/manifests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'github-access-control', source: 'github', purpose: 'Auto-generated from access control', raw_text: raw })
          });
        }).then(function() { flash('github-flash'); });
      }, 500);
    }

    async function fetchGithubRepos() {
      state.github.reposLoading = true;
      render();
      try {
        var res = await fetch('/api/github/repos');
        var data = await res.json();
        if (data.ok && data.repos) {
          state.github.repoList = data.repos.map(function(r) {
            return {
              full_name: r.full_name,
              owner: r.owner,
              name: r.name,
              private: r.private,
              description: r.description,
              is_org: r.is_org,
              enabled: r.enabled,
              permissions: r.permissions
            };
          });
          state.github.reposLoaded = true;
        }
      } catch (err) {
        console.error('Failed to fetch GitHub repos:', err);
      }
      state.github.reposLoading = false;
      render();
    }

    function toggleRepoEnabled(fullName, checked) {
      var repo = state.github.repoList.find(function(r) { return r.full_name === fullName; });
      if (repo) {
        repo.enabled = checked ? 1 : 0;
        repo.permissions = checked ? '["contents:read","issues:read","pull_requests:read"]' : '[]';
      }
      saveGithub();
      render();
    }

    function toggleRepoPerm(fullName, perm, checked) {
      var repo = state.github.repoList.find(function(r) { return r.full_name === fullName; });
      if (!repo) return;
      var perms = typeof repo.permissions === 'string' ? JSON.parse(repo.permissions) : repo.permissions.slice();
      if (checked && perms.indexOf(perm) === -1) perms.push(perm);
      if (!checked) perms = perms.filter(function(p) { return p !== perm; });
      repo.permissions = JSON.stringify(perms);
      saveGithub();
      render();
    }

    function selectAllOwner(owner, val) {
      state.github.repoList.forEach(function(r) {
        if (r.owner === owner) {
          r.enabled = val ? 1 : 0;
          r.permissions = val ? '["contents:read","issues:read","pull_requests:read"]' : '[]';
        }
      });
      saveGithub();
      render();
    }

    function applyBulkPerms() {
      var perms = [];
      if (document.getElementById('bulk-code-read').checked) perms.push('contents:read');
      if (document.getElementById('bulk-code-write').checked) perms.push('contents:write');
      if (document.getElementById('bulk-issues-read').checked) perms.push('issues:read');
      if (document.getElementById('bulk-issues-write').checked) perms.push('issues:write');
      if (document.getElementById('bulk-prs-read').checked) perms.push('pull_requests:read');
      if (document.getElementById('bulk-prs-write').checked) perms.push('pull_requests:write');
      var permStr = JSON.stringify(perms);
      state.github.repoList.forEach(function(r) {
        if (r.enabled) r.permissions = permStr;
      });
      saveGithub();
      render();
    }

    function flash(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.add('show');
      setTimeout(function() { el.classList.remove('show'); }, 1500);
    }

    // --- OAuth actions ---
    function startOAuth(source) {
      window.location.href = '/oauth/' + source + '/start';
    }

    async function disconnectSource(source) {
      if (!confirm('Disconnect ' + source + '? You will need to re-authorize.')) return;
      await fetch('/oauth/' + source + '/disconnect', { method: 'POST' });
      await fetchData();
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function relativeTime(dateStr) {
      if (!dateStr) return '';
      var now = Date.now();
      var then = new Date(dateStr + (dateStr.indexOf('Z') === -1 && dateStr.indexOf('+') === -1 ? 'Z' : '')).getTime();
      var diff = Math.floor((now - then) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
      if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
      return Math.floor(diff / 86400) + 'd ago';
    }

    function actionTypeLabel(type) {
      var labels = { draft_email: 'Draft Email', send_email: 'Send Email', reply_email: 'Reply' };
      return labels[type] || type;
    }

    function approveLabel(type) {
      var labels = { draft_email: 'Approve & Save Draft', send_email: 'Approve & Send', reply_email: 'Approve & Send Reply' };
      return labels[type] || 'Approve';
    }

    function renderPendingCards(actions) {
      var pending = actions.filter(function(a) { return a.status === 'pending'; });
      if (!pending.length) return '<p class="empty">No pending actions.</p>';
      var html = '';

      pending.forEach(function(a) {
        var data = typeof a.action_data === 'string' ? JSON.parse(a.action_data) : a.action_data;
        var label = actionTypeLabel(a.action_type);
        var safe = a.action_id.replace(/'/g, "\\\\'");

        html += '<div class="email-card" id="card-' + a.action_id + '">';
        html += '<div class="email-card-header"><span class="email-card-title">' + escapeHtml(a.purpose || data.subject || 'Untitled') + '</span></div>';
        html += '<div class="email-card-meta">';
        html += '<div class="email-field"><span class="email-field-label">To</span><span id="display-to-' + a.action_id + '">' + escapeHtml(data.to || '') + '</span><input type="text" class="email-edit-input" id="edit-to-' + a.action_id + '" value="' + escapeAttr(data.to || '') + '" style="display:none"></div>';
        html += '<div class="email-field"><span class="email-field-label">Subject</span><span id="display-subj-' + a.action_id + '">' + escapeHtml(data.subject || '') + '</span><input type="text" class="email-edit-input" id="edit-subj-' + a.action_id + '" value="' + escapeAttr(data.subject || '') + '" style="display:none"></div>';
        html += '</div>';
        html += '<div class="email-card-body"><pre class="email-body-display" id="display-body-' + a.action_id + '">' + escapeHtml(data.body || '') + '</pre><textarea class="email-body-edit" id="edit-body-' + a.action_id + '" style="display:none">' + escapeHtml(data.body || '') + '</textarea></div>';
        html += '<div class="email-card-actions">';
        html += '<button class="btn btn-edit" id="edit-btn-' + a.action_id + '" onclick="editAction(\\'' + safe + '\\')">Edit</button>';
        html += '<button class="btn btn-edit" id="cancel-btn-' + a.action_id + '" onclick="cancelEdit(\\'' + safe + '\\')" style="display:none">Cancel</button>';
        html += '<button class="btn btn-deny" onclick="resolveAction(\\'' + safe + '\\', \\'reject\\')">Deny</button>';
        html += '<button class="btn btn-approve" onclick="approveAction(\\'' + safe + '\\')">Approve</button>';
        html += '</div></div>';
      });

      return html;
    }

    function editAction(actionId) {
      ['to', 'subj', 'body'].forEach(function(f) {
        var d = document.getElementById('display-' + f + '-' + actionId);
        var e = document.getElementById('edit-' + f + '-' + actionId);
        if (d) d.style.display = 'none';
        if (e) e.style.display = '';
      });
      var eb = document.getElementById('edit-btn-' + actionId);
      var cb = document.getElementById('cancel-btn-' + actionId);
      if (eb) eb.style.display = 'none';
      if (cb) cb.style.display = '';
    }

    function cancelEdit(actionId) {
      ['to', 'subj', 'body'].forEach(function(f) {
        var d = document.getElementById('display-' + f + '-' + actionId);
        var e = document.getElementById('edit-' + f + '-' + actionId);
        if (d) d.style.display = '';
        if (e) e.style.display = 'none';
      });
      var eb = document.getElementById('edit-btn-' + actionId);
      var cb = document.getElementById('cancel-btn-' + actionId);
      if (eb) eb.style.display = '';
      if (cb) cb.style.display = 'none';
    }

    async function approveAction(actionId) {
      var editTo = document.getElementById('edit-to-' + actionId);
      if (editTo && editTo.style.display !== 'none') {
        await fetch('/api/staging/' + actionId + '/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_data: {
            to: document.getElementById('edit-to-' + actionId).value,
            subject: document.getElementById('edit-subj-' + actionId).value,
            body: document.getElementById('edit-body-' + actionId).value
          }})
        });
      }
      await resolveAction(actionId, 'approve');
    }

    async function resolveAction(actionId, decision) {
      await fetch('/api/staging/' + actionId + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      await fetchData();
    }

    async function generateKey() {
      const name = document.getElementById('newKeyName').value;
      if (!name) { alert('Enter an app name'); return; }

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      document.getElementById('newKeyResult').innerHTML =
        '<div class="key-display" style="margin-top:8px"><strong>API Key (copy now, shown only once):</strong><br>' + data.key + '</div>';
      document.getElementById('newKeyName').value = '';
      await fetchData();
    }

    async function revokeKey(id) {
      if (!confirm('Revoke key ' + id + '?')) return;
      await fetch('/api/keys/' + id, { method: 'DELETE' });
      await fetchData();
    }

    // Make functions available globally
    window.startOAuth = startOAuth;
    window.disconnectSource = disconnectSource;
    window.resolveAction = resolveAction;
    window.approveAction = approveAction;
    window.editAction = editAction;
    window.cancelEdit = cancelEdit;
    window.generateKey = generateKey;
    window.revokeKey = revokeKey;
    window.toggleRepo = toggleRepo;
    window.saveGmail = saveGmail;
    window.saveGithub = saveGithub;
    window.setAllFields = setAllFields;
    window.chk = chk;
    window.fetchGithubRepos = fetchGithubRepos;
    window.toggleRepoEnabled = toggleRepoEnabled;
    window.toggleRepoPerm = toggleRepoPerm;
    window.selectAllOwner = selectAllOwner;
    window.applyBulkPerms = applyBulkPerms;

    // Handle OAuth redirect results
    (function handleOAuthResult() {
      var params = new URLSearchParams(window.location.search);
      var success = params.get('oauth_success');
      var error = params.get('oauth_error');
      if (success) {
        // Switch to the tab of the connected source
        currentTab = success;
        document.querySelectorAll('.tab').forEach(function(t) {
          t.classList.toggle('active', t.dataset.tab === success);
        });
        // Clean URL
        window.history.replaceState({}, '', '/');
      }
      if (error) {
        alert('OAuth error: ' + error);
        window.history.replaceState({}, '', '/');
      }
    })();

    // Initial load
    fetchData();
  </script>
</body>
</html>`;
}
