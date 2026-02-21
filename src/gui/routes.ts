import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { AuditLog } from '../audit/log.js';

interface GuiDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  encryptionKey?: string;
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

    const status = decision === 'approve' ? 'approved' : 'rejected';
    deps.db.prepare(
      "UPDATE staging SET status = ?, resolved_at = datetime('now') WHERE action_id = ?",
    ).run(status, actionId);

    if (decision === 'approve') {
      auditLog.logActionApproved(actionId, 'owner');

      // Execute the action via connector
      const action = deps.db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown> | undefined;
      if (action) {
        const connector = deps.connectorRegistry.get(action.source as string);
        if (connector) {
          try {
            const result = await connector.executeAction(
              action.action_type as string,
              JSON.parse(action.action_data as string),
            );
            deps.db.prepare("UPDATE staging SET status = 'committed' WHERE action_id = ?").run(actionId);
            auditLog.logActionCommitted(actionId, action.source as string, result.success ? 'success' : 'failure');
          } catch (err) {
            auditLog.logActionCommitted(actionId, action.source as string, 'failure');
          }
        }
      }
    } else {
      auditLog.logActionRejected(actionId, 'owner');
    }

    return c.json({ ok: true, status });
  });

  // Get audit log
  app.get('/api/audit', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const event = c.req.query('event');
    const source = c.req.query('source');

    const entries = auditLog.getEntries({ event: event ?? undefined, source: source ?? undefined, limit });
    return c.json({ ok: true, entries });
  });

  // OAuth start (placeholder — actual OAuth needs real credentials)
  app.get('/oauth/:source/start', (c) => {
    const source = c.req.param('source');
    // In production, redirect to the OAuth provider
    return c.json({
      ok: true,
      message: `OAuth flow for ${source} would redirect to the provider. Configure credentials in hub-config.yaml.`,
    });
  });

  // OAuth callback (placeholder)
  app.get('/oauth/:source/callback', (c) => {
    const source = c.req.param('source');
    return c.json({
      ok: true,
      message: `OAuth callback for ${source} received. Tokens would be stored.`,
    });
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
    .toggle input[type="checkbox"] { width: 18px; height: 18px; }
    .toggle label { font-size: 13px; }
    input[type="text"], input[type="number"], select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; width: 100%; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: #555; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .empty { text-align: center; color: #999; padding: 24px; }
    .key-display { background: #f8f9fa; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 8px 0; }
    #app { min-height: 100vh; }
    .section { margin-bottom: 24px; }
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
    let state = { sources: [], manifests: [], keys: [], staging: [], audit: [] };

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
      render();
    }

    function render() {
      const content = document.getElementById('content');
      switch (currentTab) {
        case 'gmail': content.innerHTML = renderGmailTab(); break;
        case 'github': content.innerHTML = renderGitHubTab(); break;
        case 'settings': content.innerHTML = renderSettingsTab(); break;
      }
      attachEventListeners();
    }

    function renderGmailTab() {
      const gmail = state.sources.find(s => s.name === 'gmail');
      const gmailManifests = state.manifests.filter(m => m.source === 'gmail');
      const gmailStaging = state.staging.filter(a => a.source === 'gmail');
      const gmailAudit = state.audit.filter(e => {
        const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
        return e.source === 'gmail' || d.source === 'gmail';
      });

      return \`
        <div class="card">
          <h2>Gmail</h2>
          <p>Status: <span class="status \${gmail?.enabled ? 'connected' : 'disconnected'}">\${gmail?.enabled ? 'Configured' : 'Not configured'}</span></p>
          \${gmail?.boundary?.after ? '<p style="margin-top:8px;font-size:13px">Boundary: emails after ' + gmail.boundary.after + '</p>' : ''}
          <div class="actions">
            <button class="btn btn-primary" onclick="startOAuth('gmail')">Connect Gmail</button>
          </div>
        </div>

        <div class="card">
          <h2>Access Control Manifests</h2>
          \${gmailManifests.length ? '<table><tr><th>ID</th><th>Purpose</th><th>Status</th><th>Actions</th></tr>' +
            gmailManifests.map(m => '<tr><td>' + m.id + '</td><td>' + m.purpose + '</td><td><span class="status ' + m.status + '">' + m.status + '</span></td><td><button class="btn btn-danger btn-sm" onclick="deleteManifest(\\'' + m.id + '\\')">Delete</button></td></tr>').join('') +
            '</table>' : '<p class="empty">No manifests configured. Create one below.</p>'}
          <div style="margin-top:16px">
            <h3>Quick Setup Presets</h3>
            <div class="actions">
              <button class="btn btn-primary btn-sm" onclick="createPreset('gmail-readonly')">Read-only Recent</button>
              <button class="btn btn-primary btn-sm" onclick="createPreset('gmail-metadata')">Metadata Only</button>
              <button class="btn btn-primary btn-sm" onclick="createPreset('gmail-full')">Full + Redaction</button>
              <button class="btn btn-primary btn-sm" onclick="createPreset('gmail-draft')">Email Drafting</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Staging Queue</h2>
          \${gmailStaging.length ? '<table><tr><th>ID</th><th>Action</th><th>Purpose</th><th>Status</th><th>Actions</th></tr>' +
            gmailStaging.map(a => {
              const data = typeof a.action_data === 'string' ? JSON.parse(a.action_data) : a.action_data;
              return '<tr><td style="font-family:monospace;font-size:11px">' + a.action_id + '</td><td>' + a.action_type + '</td><td>' + (a.purpose || '') + '</td><td><span class="status ' + a.status + '">' + a.status + '</span></td><td>' +
                (a.status === 'pending' ? '<button class="btn btn-success btn-sm" onclick="resolveAction(\\'' + a.action_id + '\\', \\'approve\\')">Approve</button> <button class="btn btn-danger btn-sm" onclick="resolveAction(\\'' + a.action_id + '\\', \\'reject\\')">Reject</button>' : '') +
                '</td></tr>';
            }).join('') +
            '</table>' : '<p class="empty">No pending actions.</p>'}
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

      return \`
        <div class="card">
          <h2>GitHub</h2>
          <p>Status: <span class="status \${github?.enabled ? 'connected' : 'disconnected'}">\${github?.enabled ? 'Configured' : 'Not configured'}</span></p>
          \${github?.boundary?.repos ? '<div style="margin-top:12px"><h3>Allowed Repos</h3><ul style="list-style:none;padding:0">' +
            github.boundary.repos.map(r => '<li style="padding:4px 0;font-size:13px">&#x2713; ' + r + '</li>').join('') +
            '</ul></div>' : ''}
          <div class="actions">
            <button class="btn btn-primary" onclick="startOAuth('github')">Connect GitHub</button>
          </div>
        </div>
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

    function attachEventListeners() {}

    // Actions
    async function startOAuth(source) {
      const res = await fetch('/oauth/' + source + '/start');
      const data = await res.json();
      alert(data.message);
    }

    async function createPreset(preset) {
      const manifests = {
        'gmail-readonly': {
          id: 'gmail-readonly-recent',
          source: 'gmail',
          purpose: 'Read-only access to recent emails with SSN redaction',
          raw_text: '@purpose: "Read-only, recent emails"\\n@graph: pull_emails -> select_fields -> redact_sensitive\\npull_emails: pull { source: "gmail", type: "email" }\\nselect_fields: select { fields: ["title", "body", "labels", "timestamp"] }\\nredact_sensitive: transform { kind: "redact", field: "body", pattern: "\\\\\\\\b\\\\\\\\d{3}-\\\\\\\\d{2}-\\\\\\\\d{4}\\\\\\\\b", replacement: "[REDACTED]" }'
        },
        'gmail-metadata': {
          id: 'gmail-metadata-only',
          source: 'gmail',
          purpose: 'Metadata only - no email body or sender info',
          raw_text: '@purpose: "Metadata only"\\n@graph: pull_emails -> select_fields\\npull_emails: pull { source: "gmail", type: "email" }\\nselect_fields: select { fields: ["title", "labels", "timestamp"] }'
        },
        'gmail-full': {
          id: 'gmail-full-redacted',
          source: 'gmail',
          purpose: 'Full access with sensitive data redaction and body truncation',
          raw_text: '@purpose: "Full access with redaction"\\n@graph: pull_emails -> redact_sensitive -> truncate_body\\npull_emails: pull { source: "gmail", type: "email" }\\nredact_sensitive: transform { kind: "redact", field: "body", pattern: "\\\\\\\\b\\\\\\\\d{3}-\\\\\\\\d{2}-\\\\\\\\d{4}\\\\\\\\b", replacement: "[REDACTED]" }\\ntruncate_body: transform { kind: "truncate", field: "body", max_length: 5000 }'
        },
        'gmail-draft': {
          id: 'gmail-email-drafting',
          source: 'gmail',
          purpose: 'Allow apps to propose email drafts for owner review',
          raw_text: '@purpose: "Email drafting"\\n@graph: stage_it\\nstage_it: stage { action_type: "draft_email", requires_approval: true }'
        }
      };

      const m = manifests[preset];
      if (!m) return;

      await fetch('/api/manifests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m)
      });
      await fetchData();
    }

    async function deleteManifest(id) {
      if (!confirm('Delete manifest ' + id + '?')) return;
      await fetch('/api/manifests/' + id, { method: 'DELETE' });
      await fetchData();
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
    window.createPreset = createPreset;
    window.deleteManifest = deleteManifest;
    window.resolveAction = resolveAction;
    window.generateKey = generateKey;
    window.revokeKey = revokeKey;

    // Initial load
    fetchData();
  </script>
</body>
</html>`;
}
