import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '../../database/datastore.js';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { google } from 'googleapis';
import { AuditLog } from '../audit/log.js';
import { GmailConnector } from '../connectors/gmail/connector.js';
import { GoogleCalendarConnector } from '../connectors/calendar/connector.js';
import { GitHubConnector } from '../connectors/github/connector.js';
import { Octokit } from 'octokit';
import { FILTER_TYPES, applyFilters, type QuickFilter } from '../filters.js';

interface GuiDeps {
  store: DataStore;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  tokenManager: TokenManager;
}

export function createGuiRoutes(deps: GuiDeps): Hono {
  const app = new Hono();
  const auditLog = new AuditLog(deps.store);

  // Serve the SPA
  app.get('/', (c) => {
    return c.html(getIndexHtml());
  });

  // --- Auth endpoints (before middleware) ---

  // Auth status check — also tells frontend if signup is needed
  app.get('/api/auth/status', async (c) => {
    const cookie = parseCookie(c.req.header('Cookie') ?? '', 'pdh_session');
    const hasUsers = (await deps.store.getUserCount()) > 0;
    if (!cookie) return c.json({ authenticated: false, hasUsers });
    const session = await deps.store.getValidSession(cookie);
    return c.json({ authenticated: !!session, hasUsers });
  });

  // Logout
  app.post('/api/logout', async (c) => {
    const cookie = parseCookie(c.req.header('Cookie') ?? '', 'pdh_session');
    if (cookie) {
      await deps.store.deleteSession(cookie);
    }
    c.header('Set-Cookie', 'pdh_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return c.json({ ok: true });
  });

  // Session auth middleware for all /api/* routes below
  app.use('/api/*', async (c, next) => {
    const cookie = parseCookie(c.req.header('Cookie') ?? '', 'pdh_session');
    if (!cookie) return c.json({ ok: false, error: 'Unauthorized' }, 401);
    const session = await deps.store.getValidSession(cookie);
    if (!session) return c.json({ ok: false, error: 'Unauthorized' }, 401);
    await next();
  });

  // --- GUI API endpoints (protected by session middleware) ---

  // Get all sources and their status
  app.get('/api/sources', async (c) => {
    const sources = await Promise.all(Object.entries(deps.config.sources).map(async ([name, config]) => ({
      name,
      enabled: config.enabled,
      boundary: config.boundary,
      connected: await deps.tokenManager.hasToken(name),
      accountInfo: await deps.tokenManager.getAccountInfo(name),
    })));

    // Backfill Gmail account info if empty
    const gmailSource = sources.find((s) => s.name === 'gmail' && s.connected);
    if (gmailSource && (!gmailSource.accountInfo || !gmailSource.accountInfo.email)) {
      const connector = deps.connectorRegistry.get('gmail');
      if (connector && connector instanceof GmailConnector) {
        try {
          const gmailApi = google.gmail({ version: 'v1', auth: connector.getAuth() });
          const profile = await gmailApi.users.getProfile({ userId: 'me' });
          const info = { email: profile.data.emailAddress ?? undefined };
          await deps.tokenManager.updateAccountInfo('gmail', info);
          gmailSource.accountInfo = info;
        } catch (_) { /* non-fatal */ }
      }
    }

    // Backfill Calendar account info if empty
    const calSource = sources.find((s) => s.name === 'google_calendar' && s.connected);
    if (calSource && (!calSource.accountInfo || !calSource.accountInfo.email)) {
      const connector = deps.connectorRegistry.get('google_calendar');
      if (connector && connector instanceof GoogleCalendarConnector) {
        try {
          const calApi = google.calendar({ version: 'v3', auth: connector.getAuth() });
          const profile = await calApi.calendarList.get({ calendarId: 'primary' });
          const info = { email: profile.data.id ?? undefined };
          await deps.tokenManager.updateAccountInfo('google_calendar', info);
          calSource.accountInfo = info;
        } catch (_) { /* non-fatal */ }
      }
    }

    return c.json({ ok: true, sources });
  });

  // Get filters for a source
  app.get('/api/filters', async (c) => {
    const source = c.req.query('source');
    const filters = source
      ? await deps.store.getFiltersBySource(source)
      : await deps.store.getAllFilters();
    return c.json({ ok: true, filters, filterTypes: FILTER_TYPES });
  });

  // Create or update a filter
  app.post('/api/filters', async (c) => {
    const body = await c.req.json();
    const { id, source, type, value, enabled } = body;

    if (!source || !type) {
      return c.json({ ok: false, error: 'source and type are required' }, 400);
    }

    if (id) {
      // Update existing filter
      await deps.store.updateFilter(id, value ?? '', enabled ?? 1);
      return c.json({ ok: true, id });
    }

    // Create new filter
    const newId = `filter_${randomUUID().slice(0, 12)}`;
    await deps.store.createFilter({ id: newId, source, type, value: value ?? '', enabled: enabled ?? 1 });
    return c.json({ ok: true, id: newId });
  });

  // Delete a filter
  app.delete('/api/filters/:id', async (c) => {
    const id = c.req.param('id');
    await deps.store.deleteFilter(id);
    return c.json({ ok: true });
  });

  // Get staging queue
  app.get('/api/staging', async (c) => {
    const actions = await deps.store.getAllStagingActions();
    return c.json({ ok: true, actions });
  });

  // Approve/reject a staged action
  app.post('/api/staging/:actionId/resolve', async (c) => {
    const actionId = c.req.param('actionId');
    const body = await c.req.json();
    const { decision } = body; // 'approve' or 'reject'

    const action = await deps.store.getStagingAction(actionId);
    const actionSource = action?.source || null;

    const status = decision === 'approve' ? 'approved' : 'rejected';
    await deps.store.updateStagingStatus(actionId, status);

    if (decision === 'approve') {
      await auditLog.logActionApproved(actionId, 'owner', actionSource ?? undefined);

      // Execute the action via connector
      if (action) {
        const connector = deps.connectorRegistry.get(action.source);
        if (connector) {
          try {
            const actionData = JSON.parse(action.action_data);
            let actionType = action.action_type;

            // If it's a gmail source and the user clicked 'Send' (which sets send: true in action_data),
            // we override the actionType to 'send_email'.
            if (action.source === 'gmail' && actionData.send) {
              actionType = 'send_email';
            }

            const result = await connector.executeAction(
              actionType,
              actionData,
            );
            await deps.store.updateStagingStatus(actionId, 'committed');
            await auditLog.logActionCommitted(actionId, action.source, result.success ? 'success' : 'failure');
          } catch (_err) {
            await auditLog.logActionCommitted(actionId, action.source, 'failure');
          }
        }
      }
    } else {
      await auditLog.logActionRejected(actionId, 'owner', actionSource ?? undefined);
    }

    return c.json({ ok: true, status });
  });

  // Get single staging action
  app.get('/api/staging/:actionId', async (c) => {
    const actionId = c.req.param('actionId');
    const action = await deps.store.getStagingAction(actionId);
    if (!action) return c.json({ ok: false, error: 'Not found' }, 404);
    try {
      return c.json({ ok: true, action: { ...action, action_data: JSON.parse(action.action_data) } });
    } catch {
      return c.json({ ok: true, action });
    }
  });

  // Edit staging action data (only when pending)
  app.post('/api/staging/:actionId/edit', async (c) => {
    const actionId = c.req.param('actionId');
    const body = await c.req.json();
    const action = await deps.store.getStagingAction(actionId);
    if (!action) return c.json({ ok: false, error: 'Not found' }, 404);
    if (action.status !== 'pending') return c.json({ ok: false, error: 'Action is not pending' }, 400);
    const existing = JSON.parse(action.action_data);
    const merged = { ...existing, ...body.action_data };
    await deps.store.updateStagingActionData(actionId, JSON.stringify(merged));
    return c.json({ ok: true, action_data: merged });
  });

  // Get audit log
  app.get('/api/audit', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const event = c.req.query('event');
    const source = c.req.query('source');

    const entries = await auditLog.getEntries({ event: event ?? undefined, source: source ?? undefined, limit });
    return c.json({ ok: true, entries });
  });

  app.delete('/api/audit', async (c) => {
    await auditLog.clearAll();
    return c.json({ ok: true });
  });

  // --- GitHub repo discovery endpoints ---

  // Fetch all repos from GitHub API, upsert into DB, return with selection state
  app.get('/api/github/repos', async (c) => {
    const storedToken = await deps.tokenManager.getToken('github');
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
      await deps.store.upsertGitHubRepos(repos.map(repo => ({
        full_name: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        isPrivate: repo.private,
        description: repo.description ?? '',
        isOrg: repo.owner.type === 'Organization',
      })));

      // Return all repos from DB with their selection state
      const allRepos = await deps.store.getAllGitHubRepos();

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

    const updates = Object.entries(body.repos).map(([fullName, settings]) => ({
      full_name: fullName,
      enabled: settings.enabled,
      permissions: JSON.stringify(settings.permissions),
    }));
    await deps.store.updateGitHubRepoSettings(updates);

    // Rebuild allowed repos and update connector
    const enabledRepos = await deps.store.getEnabledGitHubRepos();
    const enabledNames = enabledRepos.map((r) => r.full_name);

    const connector = deps.connectorRegistry.get('github');
    if (connector && connector instanceof GitHubConnector) {
      connector.updateAllowedRepos(enabledNames);
    }

    return c.json({ ok: true });
  });

  // Fetch real calendar events from connected account
  app.get('/api/calendar/events', async (c) => {
    const connector = deps.connectorRegistry.get('google_calendar');
    if (!connector || !(connector instanceof GoogleCalendarConnector)) {
      return c.json({ ok: false, error: 'Calendar not connected' }, 401);
    }

    try {
      const calConfig = deps.config.sources.google_calendar;
      const boundary = calConfig?.boundary ?? {};
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const rows = await connector.fetch(boundary, { limit });

      const events = rows.map((row) => {
        const d = row.data as Record<string, unknown>;
        return {
          id: row.source_item_id,
          title: d.title || '',
          start: d.start || '',
          end: d.end || '',
          location: d.location || '',
          body: d.body || '',
          url: d.url || '',
          isAllDay: d.isAllDay || false,
        };
      });

      return c.json({ ok: true, events });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Preview calendar events with filters applied
  app.get('/api/calendar/preview', async (c) => {
    const connector = deps.connectorRegistry.get('google_calendar');
    if (!connector || !(connector instanceof GoogleCalendarConnector)) {
      return c.json({ ok: false, error: 'Calendar not connected' }, 401);
    }

    try {
      const calConfig = deps.config.sources.google_calendar;
      const boundary = calConfig?.boundary ?? {};
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const rows = await connector.fetch(boundary, { limit });

      const filters = await deps.store.getEnabledFiltersBySource('google_calendar') as QuickFilter[];
      const filtered = applyFilters(rows, filters);

      const mapRow = (row: import('../connectors/types.js').DataRow) => {
        const d = row.data as Record<string, unknown>;
        return {
          id: row.source_item_id,
          title: d.title || '',
          start: d.start || '',
          end: d.end || '',
          location: d.location || '',
          body: d.body || '',
          url: d.url || '',
          isAllDay: d.isAllDay || false,
        };
      };

      return c.json({
        ok: true,
        events: filtered.map(mapRow),
        totalFetched: rows.length,
        afterFilters: filtered.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Fetch real emails from connected Gmail account
  app.get('/api/gmail/emails', async (c) => {
    const connector = deps.connectorRegistry.get('gmail');
    if (!connector || !(connector instanceof GmailConnector)) {
      return c.json({ ok: false, error: 'Gmail not connected' }, 401);
    }

    try {
      const gmailConfig = deps.config.sources.gmail;
      const boundary = gmailConfig?.boundary ?? {};
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const rows = await connector.fetch(boundary, { limit });

      // Map DataRow format to the shape the frontend expects
      const emails = rows.map((row) => {
        const d = row.data as Record<string, unknown>;
        const attachments = d.attachments as Array<{ name: string }> | undefined;
        return {
          id: row.source_item_id,
          from: d.author_email || d.author_name || '',
          to: Array.isArray(d.participants)
            ? (d.participants as Array<{ email: string; role: string }>)
                .filter((p) => p.role === 'to')
                .map((p) => p.email)
                .join(', ')
            : '',
          subject: d.title || '',
          snippet: (d.snippet as string) || '',
          body: d.body || '',
          date: row.timestamp,
          labels: Array.isArray(d.labels) ? d.labels : [],
          hasAttachment: Array.isArray(attachments) && attachments.length > 0,
        };
      });

      return c.json({ ok: true, emails });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Preview emails with filters applied (for GUI preview)
  app.get('/api/gmail/preview', async (c) => {
    const connector = deps.connectorRegistry.get('gmail');
    if (!connector || !(connector instanceof GmailConnector)) {
      return c.json({ ok: false, error: 'Gmail not connected' }, 401);
    }

    try {
      const gmailConfig = deps.config.sources.gmail;
      const boundary = gmailConfig?.boundary ?? {};
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const rows = await connector.fetch(boundary, { limit });

      // Load enabled filters and apply
      const filters = await deps.store.getEnabledFiltersBySource('gmail') as QuickFilter[];
      const filtered = applyFilters(rows, filters);

      // Map DataRow format to the shape the frontend expects
      const mapRow = (row: import('../connectors/types.js').DataRow) => {
        const d = row.data as Record<string, unknown>;
        const attachments = d.attachments as Array<{ name: string }> | undefined;
        return {
          id: row.source_item_id,
          from: d.author_email || d.author_name || '',
          to: Array.isArray(d.participants)
            ? (d.participants as Array<{ email: string; role: string }>)
                .filter((p) => p.role === 'to')
                .map((p) => p.email)
                .join(', ')
            : '',
          subject: d.title || '',
          snippet: (d.snippet as string) || '',
          body: d.body || '',
          date: row.timestamp,
          labels: Array.isArray(d.labels) ? d.labels : [],
          hasAttachment: Array.isArray(attachments) && attachments.length > 0,
        };
      };

      return c.json({
        ok: true,
        emails: filtered.map(mapRow),
        totalFetched: rows.length,
        afterFilters: filtered.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ ok: false, error: message }, 500);
    }
  });

  return app;
}

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function getIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PersonalDataHub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #0fa081;
      --primary-hover: #0d8a6f;
      --bg: #f7f7ff;
      --card: #ffffff;
      --sidebar-bg: #fafbfd;
      --sidebar-border: #e5e7eb;
      --fg: #1a1a33;
      --muted: #5a6b7a;
      --destructive: #ef4444;
      --destructive-hover: #dc2626;
      --warning: #f59e0b;
      --success: #0fa081;
      --border: #e2e5e9;
      --input-border: #e2e5e9;
      --ring: #0fa081;
      --radius: 8px;
      --sidebar-width: 224px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); font-size: 15px; line-height: 1.6; }

    /* ---- Layout: sidebar + main ---- */
    #app { display: flex; min-height: 100vh; }
    .sidebar { width: var(--sidebar-width); min-width: var(--sidebar-width); background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); display: flex; flex-direction: column; position: fixed; top: 0; left: 0; bottom: 0; z-index: 40; }
    .sidebar-header { padding: 16px; border-bottom: 1px solid var(--sidebar-border); }
    .sidebar-brand { display: flex; align-items: center; gap: 10px; }
    .sidebar-brand svg { width: 22px; height: 22px; color: var(--primary); flex-shrink: 0; }
    .sidebar-brand span { font-size: 16px; font-weight: 600; color: var(--fg); letter-spacing: -0.3px; }
    .sidebar-subtitle { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .sidebar-nav { flex: 1; overflow-y: auto; padding: 12px 0; }
    .nav-group-label { padding: 0 16px; font-size: 11px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; margin-top: 16px; }
    .nav-group-label:first-child { margin-top: 0; }
    .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 14px; color: var(--muted); cursor: pointer; transition: all 0.15s; border-left: 3px solid transparent; text-decoration: none; }
    .nav-item:hover { background: rgba(0,0,0,0.03); color: var(--fg); }
    .nav-item.active { background: rgba(15,160,129,0.06); color: var(--fg); font-weight: 500; border-left-color: var(--primary); }
    .nav-item.disabled { color: rgba(90,107,122,0.4); cursor: default; pointer-events: none; }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .nav-item .nav-label { flex: 1; }
    .nav-badge { font-size: 11px; font-family: 'JetBrains Mono', monospace; background: var(--warning); color: #fff; padding: 2px 7px; border-radius: 9999px; min-width: 20px; text-align: center; font-weight: 500; }
    .nav-badge-muted { font-size: 10px; font-family: 'JetBrains Mono', monospace; text-transform: uppercase; color: rgba(90,107,122,0.5); }
    .status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .status-dot-connected { background: var(--success); box-shadow: 0 0 6px rgba(15,160,129,0.5); }
    .status-dot-disconnected { background: #b0b8c4; }
    .status-dot-pending { background: var(--warning); box-shadow: 0 0 6px rgba(245,158,11,0.5); }
    .sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--sidebar-border); }
    .sidebar-save-flash { font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--success); opacity: 0; transition: opacity 0.3s; }
    .sidebar-save-flash.show { opacity: 1; }

    /* ---- Main content area ---- */
    .main-content { flex: 1; margin-left: var(--sidebar-width); overflow-y: auto; display: flex; justify-content: center; }
    .content { width: 100%; max-width: 1600px; padding: 32px 48px; }

    /* ---- Cards ---- */
    .card { background: var(--card); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--fg); }
    .card h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: var(--muted); }

    /* ---- Status badges ---- */
    .status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .status.connected { background: rgba(15,160,129,0.1); color: var(--success); }
    .status.disconnected { background: rgba(239,68,68,0.08); color: var(--destructive); }
    .status.pending { background: rgba(245,158,11,0.1); color: #b45309; }
    .status.approved { background: rgba(15,160,129,0.1); color: var(--success); }
    .status.rejected { background: rgba(239,68,68,0.08); color: var(--destructive); }
    .status.committed { background: rgba(15,160,129,0.1); color: var(--success); }

    /* ---- Buttons ---- */
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 18px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; font-family: inherit; transition: all 0.15s; line-height: 1; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: var(--success); color: #fff; }
    .btn-success:hover { background: var(--primary-hover); }
    .btn-danger { background: var(--destructive); color: #fff; }
    .btn-danger:hover { background: var(--destructive-hover); }
    .btn-outline { background: var(--card); color: var(--fg); border: 1px solid var(--border); }
    .btn-outline:hover { background: #f5f6f8; }
    .btn-sm { padding: 6px 12px; font-size: 13px; }
    .btn-ghost { background: transparent; color: var(--muted); border: none; }
    .btn-ghost:hover { background: rgba(0,0,0,0.04); color: var(--fg); }

    /* ---- Tables ---- */
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
    th { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }

    /* ---- Forms ---- */
    .toggle { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .toggle input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary); }
    .toggle label { font-size: 14px; cursor: pointer; }
    input[type="text"], input[type="number"], select { padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 6px; font-size: 14px; font-family: inherit; width: 100%; outline: none; transition: border-color 0.15s, box-shadow 0.15s; background: var(--card); }
    input[type="text"]:focus, input[type="number"]:focus, select:focus { border-color: var(--ring); box-shadow: 0 0 0 3px rgba(15,160,129,0.1); }
    input[type="datetime-local"] { padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 6px; font-size: 14px; font-family: inherit; width: 100%; outline: none; transition: border-color 0.15s; background: var(--card); }
    input[type="datetime-local"]:focus { border-color: var(--ring); box-shadow: 0 0 0 3px rgba(15,160,129,0.1); }
    input[type="date"] { padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 6px; font-size: 14px; font-family: inherit; outline: none; transition: border-color 0.15s; background: var(--card); }
    input[type="date"]:focus { border-color: var(--ring); box-shadow: 0 0 0 3px rgba(15,160,129,0.1); }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; color: var(--muted); }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    .empty { text-align: center; color: var(--muted); padding: 24px; font-size: 14px; }
    .key-display { background: #f0fdf9; padding: 12px 16px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 13px; word-break: break-all; margin: 8px 0; border: 1px solid rgba(15,160,129,0.2); }
    .section { margin-bottom: 24px; }

    /* ---- Access control rows ---- */
    .ac-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .ac-row label { font-size: 14px; white-space: nowrap; }
    .ac-row input[type="datetime-local"] { width: auto; flex: 1; max-width: 220px; }
    .ac-row input[type="text"] { flex: 1; }
    .checkbox-group { display: flex; flex-wrap: wrap; gap: 2px 14px; }
    .checkbox-group .toggle { margin: 2px 0; position: relative; }
    .checkbox-group .toggle label { border-bottom: 1px dotted #bbb; }
    .checkbox-group .toggle label:hover::after { content: attr(data-tip); position: absolute; left: 0; top: 100%; margin-top: 4px; background: var(--fg); color: #fff; font-size: 11px; padding: 4px 8px; border-radius: 4px; white-space: nowrap; z-index: 10; pointer-events: none; }

    /* ---- Filter panel ---- */
    .filter-panel { margin-left: 26px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; display: none; }
    .filter-panel.show { display: block; }
    .filter-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .filter-row:last-child { margin-bottom: 0; }
    .filter-label { font-size: 14px; color: var(--fg); min-width: 110px; }
    .filter-row input[type="text"] { flex: 1; }
    .filter-row input[type="text"]:focus { border-color: var(--ring); }
    .filter-row input[type="date"] { flex: 1; }
    .filter-row select { border: 1px solid var(--input-border); border-radius: 6px; padding: 9px 12px; background: var(--card); font-size: 14px; font-family: inherit; outline: none; }
    .filter-row input[type="number"] { width: 100px; }
    .expand-link { font-size: 13px; color: var(--primary); cursor: pointer; text-decoration: none; margin-left: 4px; }
    .expand-link:hover { text-decoration: underline; }
    .sel-links { font-size: 12px; margin-left: 4px; }
    .sel-links a { color: var(--primary); text-decoration: none; cursor: pointer; }
    .sel-links a:hover { text-decoration: underline; }

    /* ---- GitHub repos ---- */
    .repo-item { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
    .repo-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; background: var(--sidebar-bg); transition: background 0.15s; }
    .repo-header:hover { background: #f0f1f4; }
    .repo-name { font-family: 'JetBrains Mono', monospace; font-size: 14px; flex: 1; }
    .repo-chevron { font-size: 13px; color: var(--muted); transition: transform 0.2s; }
    .repo-chevron.open { transform: rotate(90deg); }
    .repo-perms { padding: 12px 14px 4px; border-top: 1px solid var(--border); display: none; }
    .repo-perms.show { display: block; }
    .perm-grid { display: flex; gap: 24px; }
    .perm-col h4 { font-size: 13px; font-weight: 700; color: var(--fg); margin-bottom: 6px; letter-spacing: 0.3px; }

    /* ---- Save flash ---- */
    .save-flash { display: inline-block; margin-left: 10px; font-size: 13px; font-weight: 600; color: var(--success); opacity: 0; transition: opacity 0.3s; }
    .save-flash.show { opacity: 1; }

    /* ---- Email action cards ---- */
    .email-card { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; overflow: hidden; background: var(--card); transition: box-shadow 0.2s; }
    .email-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    .email-card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .email-card-title { font-size: 15px; font-weight: 600; color: var(--fg); }
    .email-card-meta { padding: 12px 18px 0; }
    .email-field { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 14px; }
    .email-field-label { font-weight: 600; color: var(--muted); min-width: 55px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
    .email-card-body { padding: 10px 18px 14px; }
    .email-body-display { white-space: pre-wrap; word-wrap: break-word; font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.7; margin: 0; background: #f8f9fb; border: none; border-radius: 6px; padding: 14px 16px; color: var(--fg); }
    .email-card-actions { display: flex; gap: 8px; padding: 0 18px 14px; justify-content: flex-end; }
    .email-card-actions .btn { border-radius: 6px; font-weight: 500; font-size: 14px; padding: 8px 18px; }
    .email-card-actions .btn-approve { background: var(--success); color: white; border: none; }
    .email-card-actions .btn-approve:hover { background: var(--primary-hover); }
    .email-card-actions .btn-deny { background: var(--card); color: var(--destructive); border: 1px solid rgba(239,68,68,0.3); }
    .email-card-actions .btn-deny:hover { background: rgba(239,68,68,0.04); border-color: var(--destructive); }
    .email-card-actions .btn-edit { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
    .email-card-actions .btn-edit:hover { background: #f5f6f8; border-color: #ccc; }
    .email-edit-input { padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 6px; font-size: 14px; font-family: inherit; flex: 1; outline: none; transition: border 0.15s; }
    .email-edit-input:focus { border-color: var(--ring); box-shadow: 0 0 0 3px rgba(15,160,129,0.1); }
    .email-body-edit { width: 100%; min-height: 120px; padding: 12px 14px; border: 1px solid var(--input-border); border-radius: 6px; font-size: 14px; font-family: inherit; resize: vertical; outline: none; transition: border 0.15s; line-height: 1.6; }
    .email-body-edit:focus { border-color: var(--ring); box-shadow: 0 0 0 3px rgba(15,160,129,0.1); }
    .resolved-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; font-size: 14px; border-bottom: 1px solid var(--border); }
    .resolved-row:last-child { border-bottom: none; }

    /* ---- Gmail 2-col grid ---- */
    .gmail-grid { display: grid; grid-template-columns: 1fr 400px; gap: 24px; }
    .gmail-grid-left { min-width: 0; }
    .gmail-grid-right { min-width: 0; }
    .gmail-top-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .gmail-top-row .card { margin-bottom: 0; }
    @media (max-width: 1200px) { .gmail-grid { grid-template-columns: 1fr 360px; } }
    @media (max-width: 1000px) { .gmail-grid { grid-template-columns: 1fr; } .gmail-top-row { grid-template-columns: 1fr; } }

    /* ---- Summary stats bar ---- */
    .summary-bar { display: flex; align-items: center; gap: 20px; padding: 10px 16px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; }
    .summary-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .summary-stat-value { font-size: 18px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--fg); }
    .summary-stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-divider { width: 1px; height: 28px; background: var(--border); }

    /* ---- Right column action review header ---- */
    .action-review-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .action-review-header h2 { margin: 0; font-size: 16px; }

    /* ---- Field pills ---- */
    .field-pill { display: inline-block; font-size: 13px; padding: 4px 12px; border-radius: 9999px; border: 1px solid; cursor: pointer; transition: all 0.15s; font-family: inherit; background: none; }
    .field-pill-on { border-color: rgba(15,160,129,0.4); background: rgba(15,160,129,0.08); color: var(--primary); }
    .field-pill-off { border-color: var(--border); color: var(--muted); text-decoration: line-through; opacity: 0.5; }
    .field-pill-off:hover { opacity: 0.75; }

    /* ---- Email list ---- */
    .email-list-header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--sidebar-bg); border-bottom: 1px solid var(--border); }
    .email-list-header .stat { font-size: 13px; color: var(--muted); }
    .email-list-header .stat strong { color: var(--fg); font-family: 'JetBrains Mono', monospace; font-weight: 600; }
    .email-list-header .stat-accent strong { color: var(--primary); }
    .email-row { border-bottom: 1px solid var(--border); position: relative; }
    .email-row:last-child { border-bottom: none; }
    .email-row-hidden .email-row-btn { opacity: 0.35; }
    .email-row-hidden .email-row-btn:hover { opacity: 0.55; }
    .email-row-btn { display: block; width: 100%; text-align: left; padding: 14px 20px; background: none; border: none; cursor: pointer; transition: all 0.15s; font-family: inherit; }
    .email-row-btn:hover { background: rgba(15,160,129,0.03); }
    .email-row-sender { font-size: 14px; font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .email-row-sender.hidden-field { color: var(--muted); text-decoration: line-through; font-weight: 400; }
    .email-row-subject { font-size: 13px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .email-row-subject.hidden-field { color: var(--muted); text-decoration: line-through; opacity: 0.5; }
    .email-row-snippet { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; line-height: 1.4; }
    .email-row-snippet.hidden-field { text-decoration: line-through; opacity: 0.4; }
    .email-row-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .email-row-date { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; white-space: nowrap; }
    .email-row-labels { display: flex; gap: 4px; margin-top: 2px; }
    .email-label { font-size: 11px; font-family: 'JetBrains Mono', monospace; padding: 2px 8px; border-radius: 4px; background: rgba(15,160,129,0.07); color: var(--primary); font-weight: 500; }
    .email-label.hidden-field { text-decoration: line-through; opacity: 0.45; }
    .email-row-labels.hidden-field { opacity: 0.5; }
    .email-row-attach { color: var(--muted); flex-shrink: 0; }
    .email-row-attach.hidden-field { opacity: 0.3; }
    .email-row-vis { width: 3px; align-self: stretch; border-radius: 2px; flex-shrink: 0; }
    .email-row-vis-on { background: var(--primary); }
    .email-row-vis-off { background: var(--border); }
    .email-expand { padding: 16px 20px 20px; border-top: 1px solid var(--border); background: #f9fafb; }
    .email-expand-field { display: flex; gap: 10px; font-size: 14px; padding: 4px 0; }
    .email-expand-field .field-label { color: var(--muted); width: 64px; flex-shrink: 0; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; padding-top: 2px; }
    .email-expand-field .field-value { color: var(--fg); font-family: 'JetBrains Mono', monospace; font-size: 13px; }
    .email-expand-field .field-value.hidden-field { text-decoration: line-through; color: var(--muted); opacity: 0.45; }
    .email-expand-body { margin-top: 12px; }
    .email-expand-body pre { white-space: pre-wrap; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-size: 13px; line-height: 1.7; color: var(--fg); font-family: 'JetBrains Mono', monospace; }
    .email-expand-body pre.hidden-field { text-decoration: line-through; color: var(--muted); opacity: 0.4; }
    .email-expand-alert { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.15); border-radius: 6px; margin-bottom: 12px; font-size: 13px; color: var(--destructive); }

    /* ---- Misc ---- */
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes flash-save { 0% { opacity: 1; } 100% { opacity: 0; } }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body>
  <!-- Login screen -->
  <div id="login-screen" style="display:none;justify-content:center;align-items:center;min-height:100vh;background:var(--bg)">
    <div style="background:var(--card);padding:40px;border-radius:12px;border:1px solid var(--border);box-shadow:0 2px 12px rgba(0,0,0,0.06);max-width:400px;width:100%">
      <div style="text-align:center;margin-bottom:24px">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <h1 style="font-size:20px;font-weight:700;margin-top:12px">PersonalDataHub</h1>
        <p id="login-subtitle" style="font-size:14px;color:var(--muted);margin-top:4px">Sign in to continue</p>
      </div>
      <form id="login-form" style="display:flex;flex-direction:column;gap:12px" onsubmit="return handleAuthSubmit(event)">
        <input id="auth-email" type="email" placeholder="Email" required style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg);color:var(--fg)">
        <input id="auth-password" type="password" placeholder="Password" required minlength="8" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg);color:var(--fg)">
        <button id="auth-submit" type="submit" class="btn btn-primary" style="width:100%;padding:10px;font-size:14px">Sign In</button>
      </form>
      <div id="login-error" style="color:var(--destructive);font-size:13px;margin-top:12px;text-align:center"></div>
    </div>
  </div>

  <div id="app" style="display:none">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>PersonalDataHub</span>
        </div>
        <div class="sidebar-subtitle">Access control for AI agents</div>
      </div>
      <nav class="sidebar-nav" id="sidebar-nav">
        <div class="nav-group-label">Overview</div>
        <a class="nav-item active" data-tab="overview" onclick="switchTab('overview')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span class="nav-label">Overview</span>
        </a>
        <div class="nav-group-label">Data Sources</div>
        <a class="nav-item" data-tab="gmail" onclick="switchTab('gmail')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          <span class="nav-label">Gmail</span>
          <span class="status-dot status-dot-disconnected" id="gmail-dot"></span>
          <span class="nav-badge" id="gmail-badge" style="display:none">0</span>
        </a>
        <a class="nav-item" data-tab="github" onclick="switchTab('github')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
          <span class="nav-label">GitHub</span>
          <span class="status-dot status-dot-disconnected" id="github-dot"></span>
        </a>
        <a class="nav-item" data-tab="google_calendar" onclick="switchTab('google_calendar')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span class="nav-label">Calendar</span>
          <span class="status-dot status-dot-disconnected" id="calendar-dot"></span>
          <span class="nav-badge" id="calendar-badge" style="display:none">0</span>
        </a>        <a class="nav-item disabled">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="nav-label">Slack</span>
          <span class="nav-badge-muted">soon</span>
        </a>
        <div class="nav-group-label">System</div>
        <a class="nav-item" data-tab="settings" onclick="switchTab('settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span class="nav-label">Settings</span>
        </a>
      </nav>
      <div class="sidebar-footer">
        <span class="sidebar-save-flash" id="sidebar-flash">Saved</span>
        <button class="btn btn-ghost btn-sm" onclick="logout()" style="width:100%;margin-top:8px;font-size:13px">Sign out</button>
      </div>
    </aside>
    <div class="main-content">
      <div class="content" id="content"></div>
    </div>
  </div>

  <script>
    let currentTab = 'overview';
    var ALL_FIELDS = ['Subject', 'Body', 'Sender', 'Recipients', 'Labels', 'Attachments', 'Snippet'];
    var DEMO_EMAILS = [
      { id:'e1', from:'alice@company.com', to:'owner@gmail.com', subject:'Q1 Planning Meeting', snippet:'Can we reschedule Thursday\\'s meeting to 2pm?', body:'Hi,\\n\\nCan we reschedule Thursday\\'s meeting to 2pm? I have a conflict with the original time.\\n\\nThanks,\\nAlice', date:'2025-02-22T09:15:00Z', labels:['Inbox'], hasAttachment:false },
      { id:'e2', from:'bob@company.com', to:'owner@gmail.com', subject:'Code Review: PR #142', snippet:'Please review the latest changes to the auth module', body:'Hey,\\n\\nI\\'ve pushed the latest changes to the auth module. Could you take a look at PR #142?\\n\\nThe main changes are:\\n- Added JWT refresh logic\\n- Fixed session expiry bug\\n- Updated tests\\n\\nThanks!', date:'2025-02-22T08:30:00Z', labels:['Inbox'], hasAttachment:false },
      { id:'e3', from:'notifications@github.com', to:'owner@gmail.com', subject:'[PersonalDataHub] Issue #23: Add rate limiting', snippet:'New issue opened by contributor', body:'A new issue has been opened in owner/PersonalDataHub:\\n\\nTitle: Add rate limiting to API endpoints\\nOpened by: @contributor\\n\\nWe should add rate limiting to prevent abuse of the API endpoints.', date:'2025-02-22T07:45:00Z', labels:['Inbox','GitHub'], hasAttachment:false },
      { id:'e4', from:'team@company.com', to:'owner@gmail.com', subject:'Weekly Standup Notes - Feb 21', snippet:'Here are this week\\'s standup notes', body:'Team standup notes:\\n\\n- Alice: Finishing Q1 roadmap\\n- Bob: Auth module refactor\\n- Carol: Performance testing\\n- Owner: Access control gateway MVP\\n\\nAction items:\\n1. Schedule Q1 review\\n2. Deploy staging build', date:'2025-02-21T17:00:00Z', labels:['Inbox','Starred'], hasAttachment:false },
      { id:'e5', from:'carol@company.com', to:'owner@gmail.com', subject:'Performance Report Q4', snippet:'Attached is the Q4 performance report with benchmarks', body:'Hi,\\n\\nPlease find attached the Q4 performance report. Key highlights:\\n- API latency reduced by 34%\\n- Uptime: 99.97%\\n- Error rate: 0.02%\\n\\nLet me know if you have questions.', date:'2025-02-21T14:20:00Z', labels:['Inbox'], hasAttachment:true },
      { id:'e6', from:'noreply@stripe.com', to:'owner@gmail.com', subject:'Your January invoice is ready', snippet:'Your invoice for January 2025 is now available', body:'Your invoice for January 2025 is now available.\\n\\nAmount: $49.00\\nPlan: Pro\\nPeriod: Jan 1 - Jan 31, 2025\\n\\nView your invoice at dashboard.stripe.com', date:'2025-02-01T10:00:00Z', labels:['Inbox'], hasAttachment:true },
      { id:'e7', from:'owner@gmail.com', to:'team@company.com', subject:'Project Update - PersonalDataHub', snippet:'Quick update on the access control project', body:'Team,\\n\\nQuick update on PersonalDataHub:\\n- OAuth flow completed\\n- Gmail integration working\\n- GitHub permissions UI done\\n- Next: Action staging & audit log\\n\\nETA for MVP: end of February.', date:'2025-02-20T09:00:00Z', labels:['Sent'], hasAttachment:false },
      { id:'e8', from:'security@google.com', to:'owner@gmail.com', subject:'Security alert: New sign-in', snippet:'We noticed a new sign-in to your Google Account', body:'We noticed a new sign-in to your Google Account.\\n\\nDevice: MacBook Pro\\nLocation: San Francisco, CA\\nTime: Feb 19, 2025 3:45 PM\\n\\nIf this was you, you can disregard this email.', date:'2025-02-19T15:45:00Z', labels:['Inbox'], hasAttachment:false },
      { id:'e9', from:'dave@external.io', to:'owner@gmail.com', subject:'Partnership Proposal', snippet:'Would love to discuss a potential integration', body:'Hi,\\n\\nI\\'m Dave from External.io. We\\'d love to discuss a potential integration between our platform and PersonalDataHub.\\n\\nWould you be available for a 30-min call next week?\\n\\nBest,\\nDave', date:'2025-02-18T11:30:00Z', labels:['Inbox'], hasAttachment:false },
      { id:'e10', from:'hr@company.com', to:'owner@gmail.com', subject:'Benefits Enrollment Reminder', snippet:'Open enrollment closes Feb 28', body:'Reminder: Open enrollment for 2025 benefits closes on February 28.\\n\\nPlease review and update your selections at benefits.company.com.\\n\\nQuestions? Contact HR.', date:'2025-02-15T08:00:00Z', labels:['Inbox'], hasAttachment:true },
      { id:'e11', from:'alice@company.com', to:'owner@gmail.com', subject:'Re: API Design Review', snippet:'Looks good, just a few minor suggestions', body:'Looks good overall! A few suggestions:\\n\\n1. Consider pagination for the list endpoint\\n2. Add rate limiting headers\\n3. Document the error codes\\n\\nOtherwise LGTM.', date:'2025-02-14T16:00:00Z', labels:['Inbox'], hasAttachment:false },
      { id:'e12', from:'newsletter@techweekly.com', to:'owner@gmail.com', subject:'This Week in Tech: AI Privacy Concerns', snippet:'The latest on AI regulation and data privacy', body:'This Week in Tech Newsletter\\n\\n1. EU proposes new AI transparency rules\\n2. Major breach at social media company\\n3. Open source privacy tools gaining traction\\n4. Interview: Building privacy-first AI agents\\n\\nRead more at techweekly.com', date:'2025-02-13T06:00:00Z', labels:['Inbox','Newsletter'], hasAttachment:false },
    ];

    let state = {
      sources: [], filters: [], staging: [], audit: [],
      gmail: {},
      github: { repoList: [], reposLoading: false, reposLoaded: false, filterOwner: '', search: '' },
      expandedRepos: {},
      expandedEmail: null,
      editingAction: null,
      realEmails: null,
      emailsLoading: false,
      emailsError: null,
      realEvents: null,
      eventsLoading: false,
      eventsError: null,
      filterTypes: {},    };
    let _saveTimer = null;

    // Sidebar nav switching
    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.nav-item[data-tab]').forEach(function(el) {
        el.classList.toggle('active', el.dataset.tab === tab);
      });
      render();
    }
    window.switchTab = switchTab;

    async function fetchData() {
      const [sources, filtersData, staging, audit] = await Promise.all([
        fetch('/api/sources').then(r => r.json()),
        fetch('/api/filters').then(r => r.json()),
        fetch('/api/staging').then(r => r.json()),
        fetch('/api/audit?limit=20').then(r => r.json()),
      ]);
      state.sources = sources.sources || [];
      state.filters = filtersData.filters || [];
      state.filterTypes = filtersData.filterTypes || {};
      state.staging = staging.actions || [];
      state.audit = audit.entries || [];

      // Fetch real emails if Gmail is connected (uses preview with filters)
      const gm = state.sources.find(s => s.name === 'gmail');
      if (gm && gm.connected && !state.realEmails && !state.emailsLoading) {
        state.emailsLoading = true;
        state.emailsError = null;
        fetch('/api/gmail/preview?limit=20&t=' + Date.now())
          .then(function(r) { return r.json(); })
          .then(function(data) {
            state.emailsLoading = false;
            if (data.ok && data.emails) {
              state.realEmails = data.emails;
              state.emailsError = null;
            } else {
              state.emailsError = data.error || 'Failed to load emails';
            }
            render();
          })
          .catch(function(err) {
            state.emailsLoading = false;
            state.emailsError = err.message || 'Network error';
            render();
          });
      }

      // Fetch real calendar events if Google Calendar is connected
      const cal = state.sources.find(s => s.name === 'google_calendar');
      if (cal && cal.connected && !state.realEvents && !state.eventsLoading) {
        state.eventsLoading = true;
        state.eventsError = null;
        fetch('/api/calendar/preview?limit=20&t=' + Date.now())
          .then(function(r) { return r.json(); })
          .then(function(data) {
            state.eventsLoading = false;
            if (data.ok && data.events) {
              state.realEvents = data.events;
              state.eventsError = null;
            } else {
              state.eventsError = data.error || 'Failed to load events';
            }
            render();
          })
          .catch(function(err) {
            state.eventsLoading = false;
            state.eventsError = err.message || 'Network error';
            render();
          });
      }
      render();
    }

    function render() {
      var focused = document.activeElement;
      var focusId = focused && focused.id ? focused.id : null;
      var cursorPos = focused && focused.selectionStart != null ? focused.selectionStart : null;

      const content = document.getElementById('content');
      switch (currentTab) {
        case 'overview': content.innerHTML = renderOverviewTab(); break;
        case 'gmail': content.innerHTML = renderGmailTab(); break;
        case 'github': content.innerHTML = renderGitHubTab(); break;
        case 'google_calendar': content.innerHTML = renderCalendarTab(); break;
        case 'settings': content.innerHTML = renderSettingsTab(); break;
      }
      // Update sidebar badges and status dots
      var gmailPendingCount = state.staging.filter(function(a) { return a.source === 'gmail' && a.status === 'pending'; }).length;
      var gmailBadge = document.getElementById('gmail-badge');
      if (gmailBadge) {
        if (gmailPendingCount) { gmailBadge.textContent = gmailPendingCount; gmailBadge.style.display = ''; }
        else { gmailBadge.style.display = 'none'; }
      }
      var calPendingCount = state.staging.filter(function(a) { return a.source === 'google_calendar' && a.status === 'pending'; }).length;
      var calBadge = document.getElementById('calendar-badge');
      if (calBadge) {
        if (calPendingCount) { calBadge.textContent = calPendingCount; calBadge.style.display = ''; }
        else { calBadge.style.display = 'none'; }
      }
      // Gmail status dot
      var gmailSource = state.sources.find(function(s) { return s.name === 'gmail'; });
      var gmailDot = document.getElementById('gmail-dot');
      if (gmailDot) {
        gmailDot.className = 'status-dot ' + (gmailSource && gmailSource.connected ? 'status-dot-connected' : 'status-dot-disconnected');
      }
      // Calendar status dot
      var calSource = state.sources.find(function(s) { return s.name === 'google_calendar'; });
      var calDot = document.getElementById('calendar-dot');
      if (calDot) {
        calDot.className = 'status-dot ' + (calSource && calSource.connected ? 'status-dot-connected' : 'status-dot-disconnected');
      }
      // GitHub status dot
      var ghSource = state.sources.find(function(s) { return s.name === 'github'; });
      var ghDot = document.getElementById('github-dot');
      if (ghDot) {
        ghDot.className = 'status-dot ' + (ghSource && ghSource.connected ? 'status-dot-connected' : 'status-dot-disconnected');
      }

      if (focusId) {
        var el = document.getElementById(focusId);
        if (el) { el.focus(); if (cursorPos != null && el.setSelectionRange) el.setSelectionRange(cursorPos, cursorPos); }
      }
    }

    function chk(v) { return v ? 'checked' : ''; }

    function renderOverviewTab() {
      var gmail = state.sources.find(function(s) { return s.name === 'gmail'; });
      var github = state.sources.find(function(s) { return s.name === 'github'; });
      var cal = state.sources.find(function(s) { return s.name === 'google_calendar'; });
      var gmailConnected = gmail && gmail.connected;
      var ghConnected = github && github.connected;
      var calConnected = cal && cal.connected;
      var gmailAccount = gmail && gmail.accountInfo;
      var ghAccount = github && github.accountInfo;
      var calAccount = cal && cal.accountInfo;
      var gmailFilters = (state.filters || []).filter(function(f) { return f.source === 'gmail'; });
      var activeFilterCount = gmailFilters.filter(function(f) { return f.enabled; }).length;
      var calFilters = (state.filters || []).filter(function(f) { return f.source === 'google_calendar'; });
      var activeCalFilterCount = calFilters.filter(function(f) { return f.enabled; }).length;
      var enabledRepos = (state.github.repoList || []).filter(function(r) { return r.enabled; }).length;
      var totalRepos = (state.github.repoList || []).length;
      var pendingCount = state.staging.filter(function(a) { return a.status === 'pending'; }).length;

      var recentHtml = '';
      if (state.audit.length) {
        recentHtml = state.audit.slice(0, 5).map(function(e) {
          var d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
          var evClass = '';
          if (e.event.indexOf('approved') !== -1 || e.event.indexOf('committed') !== -1) evClass = 'connected';
          else if (e.event.indexOf('rejected') !== -1) evClass = 'rejected';
          else if (e.event.indexOf('proposed') !== -1) evClass = 'pending';
          var time = new Date(e.timestamp);
          var timeStr = time.getHours().toString().padStart(2,'0') + ':' + time.getMinutes().toString().padStart(2,'0');
          var respLine = d.responseSummary ? '<div style="padding:2px 0 4px 52px;border-bottom:1px solid var(--border)"><details style="font-size:12px;color:var(--muted);cursor:pointer"><summary style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><em>Response:</em> ' + formatResponsePreview(d.responseSummary) + '</summary>' + formatResponseDetails(d.responseSummary) + '</details></div>' : '';
          return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;' + (respLine ? '' : 'border-bottom:1px solid var(--border);') + 'font-size:14px">' +
            '<span class="font-mono" style="font-size:14px;color:var(--muted);min-width:40px">' + timeStr + '</span>' +
            '<span class="status ' + evClass + '" style="font-size:14px">' + e.event + '</span>' +
            '<span style="flex:1;color:var(--muted);font-size:14px;overflow-wrap:break-word;word-break:break-word">' + (d.purpose || d.result || (e.source || '')) + '</span>' +
            '</div>' + respLine;
        }).join('');
      } else {
        recentHtml = '<p class="empty">No recent activity.</p>';
      }

      return \`
        <div style="margin-bottom:24px">
          <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.5px;color:var(--fg)">Access Control Gateway</h1>
          <p style="font-size:14px;color:var(--muted);margin-top:4px">Zero access by default. Control exactly what AI agents can see.</p>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px">
          <div class="card" style="cursor:pointer" onclick="switchTab('gmail')">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                <span style="font-weight:600;font-size:14px">Gmail</span>
              </div>
              <span class="status-dot \${gmailConnected ? 'status-dot-connected' : 'status-dot-disconnected'}"></span>
            </div>
            \${gmailConnected && gmailAccount && gmailAccount.email ? '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">' + gmailAccount.email + '</p>' : '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">Not connected</p>'}
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:14px;color:var(--muted)">Filters: <strong class="font-mono" style="color:var(--fg)">\${activeFilterCount} active</strong></span>
              \${pendingCount ? '<span class="nav-badge">' + pendingCount + ' pending</span>' : ''}
            </div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:4px;font-size:14px;color:var(--primary);font-weight:500">Configure <span style="font-size:14px">&rarr;</span></div>
          </div>

          <div class="card" style="cursor:pointer" onclick="switchTab('google_calendar')">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span style="font-weight:600;font-size:14px">Calendar</span>
              </div>
              <span class="status-dot \${calConnected ? 'status-dot-connected' : 'status-dot-disconnected'}"></span>
            </div>
            \${calConnected && calAccount && calAccount.email ? '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">' + calAccount.email + '</p>' : '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">Not connected</p>'}
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:14px;color:var(--muted)">Filters: <strong class="font-mono" style="color:var(--fg)">\${activeCalFilterCount} active</strong></span>
            </div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:4px;font-size:14px;color:var(--primary);font-weight:500">Configure <span style="font-size:14px">&rarr;</span></div>
          </div>

          <div class="card" style="cursor:pointer" onclick="switchTab('github')">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                <span style="font-weight:600;font-size:14px">GitHub</span>
              </div>
              <span class="status-dot \${ghConnected ? 'status-dot-connected' : 'status-dot-disconnected'}"></span>
            </div>
            \${ghConnected && ghAccount && ghAccount.login ? '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">@' + ghAccount.login + '</p>' : '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">Not connected</p>'}
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:14px;color:var(--muted)">Repos: <strong class="font-mono" style="color:var(--fg)">\${enabledRepos} selected</strong></span>
            </div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:4px;font-size:14px;color:var(--primary);font-weight:500">Configure <span style="font-size:14px">&rarr;</span></div>
          </div>

          <div class="card" style="cursor:pointer" onclick="switchTab('settings')">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              <span style="font-weight:600;font-size:14px">Audit Log</span>
            </div>
            <span style="font-size:14px;color:var(--muted)"><strong class="font-mono" style="color:var(--fg)">\${state.audit.length}</strong> events recorded</span>
            <div style="margin-top:12px;display:flex;align-items:center;gap:4px;font-size:14px;color:var(--primary);font-weight:500">View log <span style="font-size:14px">&rarr;</span></div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <h2 style="margin:0">Recent Activity</h2>
            \${state.audit.length ? '<button class="btn btn-sm" style="font-size:12px;padding:4px 10px;color:var(--destructive);border-color:var(--destructive)" onclick="clearAuditLog()">Clear history</button>' : ''}
          </div>
          \${recentHtml}
        </div>
      \`;
    }

    function renderGmailTab() {
      var gmail = state.sources.find(function(s) { return s.name === 'gmail'; });
      var s = state.gmail;
      var realStaging = state.staging.filter(function(a) { return a.source === 'gmail'; });
      var gmailStaging = realStaging;
      var pendingCount = gmailStaging.filter(function(a) { return a.status === 'pending'; }).length;

      var gmailFilters = (state.filters || []).filter(function(f) { return f.source === 'gmail'; });

      var gmailConnected = gmail && gmail.connected;
      var gmailAccount = gmail && gmail.accountInfo;
      var accountEmail = gmailAccount && gmailAccount.email ? gmailAccount.email : '';

      // Emails are already filtered server-side via /api/gmail/preview
      var emails = state.realEmails || DEMO_EMAILS;
      var visibleEmails = emails;

      // Disconnected state
      if (!gmailConnected) {
        return '<div style="max-width:480px;margin:60px auto;text-align:center">' +
          '<h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Gmail</h1>' +
          '<p style="font-size:14px;color:var(--muted);margin-bottom:4px">Connect your Gmail account to browse and control agent access to your emails.</p>' +
          '<p style="font-size:14px;color:var(--muted);margin-bottom:24px;opacity:0.7">Powered by OAuth &mdash; we never store your password.</p>' +
          '<button class="btn btn-primary" onclick="startOAuth(\\'gmail\\')" style="gap:8px">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>' +
            'Connect Gmail</button></div>';
      }

      // Build email list (emails are already filtered server-side)
      var emailListHtml = '';
      visibleEmails.forEach(function(em) {
        var isExpanded = state.expandedEmail === em.id;
        var safe = em.id.replace(/'/g, "\\\\'");
        var dt = new Date(em.date);
        var timeStr = dt.toLocaleDateString(undefined, { month:'short', day:'numeric' });

        emailListHtml += '<div class="email-row">';
        emailListHtml += '<button class="email-row-btn" onclick="toggleEmailExpand(\\'' + safe + '\\')">';
        emailListHtml += '<div style="display:flex;gap:12px;width:100%">';
        emailListHtml += '<div class="email-row-vis email-row-vis-on"></div>';
        emailListHtml += '<div style="flex:1;min-width:0">';
        emailListHtml += '<div style="display:flex;align-items:center;gap:8px">';
        emailListHtml += '<span class="email-row-sender">' + escapeHtml(em.from) + '</span>';
        if (em.hasAttachment) emailListHtml += '<svg class="email-row-attach" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
        emailListHtml += '<span class="email-row-date" style="margin-left:auto">' + timeStr + '</span>';
        emailListHtml += '</div>';
        emailListHtml += '<div class="email-row-subject">' + escapeHtml(em.subject) + '</div>';
        if (em.snippet) emailListHtml += '<div class="email-row-snippet">' + escapeHtml(em.snippet) + '</div>';
        if (em.labels && em.labels.length) {
          emailListHtml += '<div class="email-row-labels">';
          em.labels.forEach(function(l) { emailListHtml += '<span class="email-label">' + escapeHtml(l) + '</span>'; });
          emailListHtml += '</div>';
        }
        emailListHtml += '</div>';
        emailListHtml += '</div></button>';

        if (isExpanded) {
          emailListHtml += '<div class="email-expand">';
          emailListHtml += '<div class="email-expand-field"><span class="field-label">From</span><span class="field-value">' + escapeHtml(em.from) + '</span></div>';
          emailListHtml += '<div class="email-expand-field"><span class="field-label">To</span><span class="field-value">' + escapeHtml(em.to) + '</span></div>';
          emailListHtml += '<div class="email-expand-field"><span class="field-label">Subject</span><span class="field-value">' + escapeHtml(em.subject) + '</span></div>';
          if (em.labels && em.labels.length) {
            emailListHtml += '<div class="email-expand-field"><span class="field-label">Labels</span><span class="field-value">' + em.labels.map(function(l) { return escapeHtml(l); }).join(', ') + '</span></div>';
          }
          if (em.hasAttachment) {
            emailListHtml += '<div class="email-expand-field"><span class="field-label">Attach.</span><span class="field-value">' + (em.attachments ? em.attachments.map(function(a) { return escapeHtml(a); }).join(', ') : 'Yes') + '</span></div>';
          }
          emailListHtml += '<div class="email-expand-body"><pre>' + escapeHtml(em.body) + '</pre></div>';
          emailListHtml += '</div>';
        }
        emailListHtml += '</div>';
      });

      // Build action cards
      var actionHtml = '';
      gmailStaging.forEach(function(a) {
        var data = typeof a.action_data === 'string' ? JSON.parse(a.action_data) : a.action_data;
        var isPending = a.status === 'pending';
        var isReviewing = state.editingAction === a.action_id;
        var safe = a.action_id.replace(/'/g, "\\\\'");
        var borderClass = isPending ? 'border-left:3px solid var(--warning)' : a.status === 'approved' ? 'border-left:3px solid var(--success);opacity:0.6' : 'border-left:3px solid var(--destructive);opacity:0.6';
        var statusClass = isPending ? 'pending' : a.status === 'approved' ? 'connected' : 'rejected';
        var typeLabel = a.action_type === 'reply_email' ? 'reply' : a.action_type === 'draft_email' ? 'draft' : a.action_type;
        var time = new Date(a.proposed_at || a.createdAt);
        var timeStr = time.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

        actionHtml += '<div class="card" style="padding:16px;' + borderClass + '">';
        actionHtml += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
        actionHtml += '<div style="display:flex;align-items:center;gap:6px">';
        actionHtml += '<span class="status ' + statusClass + '" style="font-size:14px;font-family:JetBrains Mono,monospace;text-transform:uppercase;padding:2px 8px">' + a.status + '</span>';
        actionHtml += '<span style="font-size:14px;font-family:JetBrains Mono,monospace;color:var(--muted);text-transform:uppercase">' + typeLabel + '</span>';
        actionHtml += '</div>';
        actionHtml += '<span style="font-size:14px;font-family:JetBrains Mono,monospace;color:var(--muted)">' + timeStr + '</span>';
        actionHtml += '</div>';
        if (a.purpose) actionHtml += '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">' + escapeHtml(a.purpose) + '</p>';

        // Collapsed: show To, Subj, truncated body
        if (!isReviewing) {
          actionHtml += '<div style="font-size:14px;display:flex;flex-direction:column;gap:4px">';
          actionHtml += '<div style="display:flex;gap:8px"><span style="color:var(--muted);width:36px;flex-shrink:0">To:</span><span class="font-mono" style="color:var(--fg)">' + escapeHtml(data.to || '') + '</span></div>';
          actionHtml += '<div style="display:flex;gap:8px"><span style="color:var(--muted);width:36px;flex-shrink:0">Subj:</span><span class="font-mono" style="color:var(--fg)">' + escapeHtml(data.subject || '') + '</span></div>';
          actionHtml += '<pre class="font-mono" style="white-space:pre-wrap;background:rgba(0,0,0,0.03);border-radius:6px;padding:8px;font-size:14px;color:var(--fg);max-height:80px;overflow:hidden;margin-top:4px;cursor:pointer;position:relative" onclick="toggleEditAction(\\'' + safe + '\\')">' + escapeHtml(data.body || '') + '<span style="position:absolute;bottom:0;left:0;right:0;height:28px;background:linear-gradient(transparent,#f5f5f5);pointer-events:none"></span></pre>';
          actionHtml += '</div>';
        }

        // Expanded: full editable view
        if (isReviewing) {
          actionHtml += '<div style="font-size:14px;display:flex;flex-direction:column;gap:6px">';
          actionHtml += '<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--muted);width:36px;flex-shrink:0">To:</span><input type="text" class="email-edit-input" id="edit-to-' + a.action_id + '" value="' + escapeAttr(data.to || '') + '" style="font-family:JetBrains Mono,monospace;font-size:14px;padding:4px 8px"></div>';
          actionHtml += '<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--muted);width:36px;flex-shrink:0">Subj:</span><input type="text" class="email-edit-input" id="edit-subj-' + a.action_id + '" value="' + escapeAttr(data.subject || '') + '" style="font-family:JetBrains Mono,monospace;font-size:14px;padding:4px 8px"></div>';
          actionHtml += '<div><span style="color:var(--muted);display:block;margin-bottom:4px">Body:</span><textarea class="email-body-edit" id="edit-body-' + a.action_id + '" style="font-family:JetBrains Mono,monospace;font-size:14px;min-height:160px">' + escapeHtml(data.body || '') + '</textarea></div>';
          actionHtml += '</div>';
        }

        // Buttons
        if (isPending) {
          actionHtml += '<div style="display:flex;align-items:center;gap:6px;margin-top:12px">';
          if (!isReviewing) {
            actionHtml += '<button class="btn btn-sm btn-outline" style="gap:4px" onclick="toggleEditAction(\\'' + safe + '\\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Review</button>';
          } else {
            actionHtml += '<button class="btn btn-sm btn-outline" style="color:var(--destructive);border-color:rgba(239,68,68,0.3);gap:4px" onclick="resolveAction(\\'' + safe + '\\', \\'reject\\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Deny</button>';
            actionHtml += '<button class="btn btn-sm" style="background:var(--primary);color:#fff;gap:4px" onclick="approveAction(\\'' + safe + '\\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg> Save to Draft</button>';
            actionHtml += '<button class="btn btn-sm" style="background:var(--success);color:#fff;gap:4px" onclick="sendAction(\\'' + safe + '\\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send</button>';
          }
          actionHtml += '</div>';
        }
        actionHtml += '</div>';
      });
      if (!actionHtml) actionHtml = '<div class="card" style="padding:24px;text-align:center;color:var(--muted);font-size:14px">No pending actions from agents.</div>';

      return \`
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
          <div style="display:flex;align-items:center;gap:16px">
            <div>
              <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.5px;color:var(--fg)">Gmail</h1>
              \${accountEmail ? '<p style="font-size:13px;color:var(--muted);margin-top:2px">' + escapeHtml(accountEmail) + '</p>' : ''}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" style="color:var(--destructive);border-color:rgba(239,68,68,0.3)" onclick="if(confirm('Disconnect Gmail? This will revoke all access tokens and disable Gmail access for all agents.')){disconnectSource('gmail')}">Disconnect</button>
        </div>

        <div class="card" style="padding:20px;margin-bottom:16px">
          <label style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:14px">Quick Filters</label>
          \${renderFilterCards(gmailFilters)}
        </div>

        <div class="gmail-grid">
          <div class="gmail-grid-left">
            <div class="action-review-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted)"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <h2 style="margin:0">Agent Access Preview</h2>
            </div>
            <div class="card" style="padding:0;overflow:hidden">
              <div class="email-list-header">
                <span class="stat">Showing: <strong>\${visibleEmails.length}</strong> emails</span>
                \${!state.realEmails && gmailConnected && !state.emailsLoading ? '<span style="margin-left:auto;font-size:12px;color:var(--muted);opacity:0.7">Sample data</span>' : ''}
                \${state.realEmails && gmailConnected ? '<button onclick="refreshEmails()" style="margin-left:auto;background:none;border:1px solid var(--border);border-radius:4px;padding:2px 10px;font-size:12px;color:var(--muted);cursor:pointer">Refresh</button>' : ''}
              </div>
              \${state.emailsLoading
                ? '<div style="padding:40px;text-align:center"><p style="color:var(--muted);font-size:14px">Loading emails from Gmail...</p></div>'
                : state.emailsError
                  ? '<div style="padding:40px;text-align:center"><p style="color:var(--destructive);font-size:14px">Error: ' + escapeHtml(state.emailsError) + '</p><button class="btn btn-primary" onclick="refreshEmails()" style="margin-top:12px">Retry</button></div>'
                  : (emailListHtml || '<p class="empty" style="padding:40px">No emails found.</p>')}
            </div>
          </div>

          <div class="gmail-grid-right">
            <div class="action-review-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted)"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <h2 style="margin:0">Agent Action Review</h2>
              \${pendingCount ? '<span class="nav-badge">' + pendingCount + '</span>' : ''}
            </div>
            \${actionHtml}
          </div>
        </div>
        </div>
      \`;
    }

    function renderCalendarTab() {
      var cal = state.sources.find(function(s) { return s.name === 'google_calendar'; });
      var realStaging = state.staging.filter(function(a) { return a.source === 'google_calendar'; });
      var calStaging = realStaging;
      var pendingCount = calStaging.filter(function(a) { return a.status === 'pending'; }).length;

      var calFilters = (state.filters || []).filter(function(f) { return f.source === 'google_calendar'; });

      var calConnected = cal && cal.connected;
      var calAccount = cal && cal.accountInfo;
      var accountEmail = calAccount && calAccount.email ? calAccount.email : '';

      var events = state.realEvents || [];
      // Sort events by start date descending (most recent at top)
      var sortedEvents = events.slice().sort(function(a, b) {
        return new Date(b.start).getTime() - new Date(a.start).getTime();
      });
      var visibleEvents = sortedEvents;

      // Disconnected state
      if (!calConnected) {
        return '<div style="max-width:480px;margin:60px auto;text-align:center">' +
          '<h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Calendar</h1>' +
          '<p style="font-size:14px;color:var(--muted);margin-bottom:4px">Connect your Google Calendar account to control agent access to your events.</p>' +
          '<p style="font-size:14px;color:var(--muted);margin-bottom:24px;opacity:0.7">Powered by OAuth &mdash; we never store your password.</p>' +
          '<button class="btn btn-primary" onclick="startOAuth(\\'google_calendar\\')" style="gap:8px">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
            'Connect Calendar</button></div>';
      }

      // Build event list
      var eventListHtml = '';
      visibleEvents.forEach(function(ev) {
        var safe = ev.id.replace(/'/g, "\\\\'");
        var dt = new Date(ev.start);
        var timeStr = dt.toLocaleDateString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });

        eventListHtml += '<div class="email-row" style="padding:12px 16px">';
        eventListHtml += '<div style="display:flex;gap:12px;width:100%">';
        eventListHtml += '<div class="email-row-vis email-row-vis-on"></div>';
        eventListHtml += '<div style="flex:1;min-width:0">';
        eventListHtml += '<div style="display:flex;align-items:center;gap:8px">';
        eventListHtml += '<span class="email-row-sender">' + escapeHtml(ev.title) + '</span>';
        eventListHtml += '<span class="email-row-date" style="margin-left:auto">' + timeStr + '</span>';
        eventListHtml += '</div>';
        if (ev.location) eventListHtml += '<div style="font-size:12px;color:var(--muted);margin-top:2px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' + escapeHtml(ev.location) + '</div>';
        if (ev.body) eventListHtml += '<div class="email-row-snippet" style="margin-top:4px">' + escapeHtml(ev.body) + '</div>';
        eventListHtml += '</div>';
        eventListHtml += '</div>';
        eventListHtml += '</div>';
      });

      // Build action cards
      var actionHtml = '';
      calStaging.forEach(function(a) {
        var data = typeof a.action_data === 'string' ? JSON.parse(a.action_data) : a.action_data;
        var isPending = a.status === 'pending';
        var safe = a.action_id.replace(/'/g, "\\\\'");
        var borderClass = isPending ? 'border-left:3px solid var(--warning)' : a.status === 'approved' ? 'border-left:3px solid var(--success);opacity:0.6' : 'border-left:3px solid var(--destructive);opacity:0.6';
        var statusClass = isPending ? 'pending' : a.status === 'approved' ? 'connected' : 'rejected';
        var typeLabel = a.action_type.replace('_event', '');
        var time = new Date(a.proposed_at || a.createdAt);
        var timeStr = time.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

        actionHtml += '<div class="card" style="padding:16px;' + borderClass + '">';
        actionHtml += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
        actionHtml += '<div style="display:flex;align-items:center;gap:6px">';
        actionHtml += '<span class="status ' + statusClass + '" style="font-size:14px;font-family:JetBrains Mono,monospace;text-transform:uppercase;padding:2px 8px">' + a.status + '</span>';
        actionHtml += '<span style="font-size:14px;font-family:JetBrains Mono,monospace;color:var(--muted);text-transform:uppercase">' + typeLabel + '</span>';
        actionHtml += '</div>';
        actionHtml += '<span style="font-size:14px;font-family:JetBrains Mono,monospace;color:var(--muted)">' + timeStr + '</span>';
        actionHtml += '</div>';
        if (a.purpose) actionHtml += '<p style="font-size:14px;color:var(--muted);margin-bottom:8px">' + escapeHtml(a.purpose) + '</p>';

        actionHtml += '<div style="font-size:14px;display:flex;flex-direction:column;gap:4px">';
        actionHtml += '<div style="display:flex;gap:8px"><span style="color:var(--muted);width:48px;flex-shrink:0">Event:</span><span class="font-mono" style="color:var(--fg)">' + escapeHtml(data.title || '') + '</span></div>';
        if (data.start) actionHtml += '<div style="display:flex;gap:8px"><span style="color:var(--muted);width:48px;flex-shrink:0">Start:</span><span class="font-mono" style="color:var(--fg)">' + new Date(data.start).toLocaleString() + '</span></div>';
        actionHtml += '</div>';

        if (isPending) {
          actionHtml += '<div style="display:flex;align-items:center;gap:6px;margin-top:12px">';
          actionHtml += '<button class="btn btn-sm btn-outline" style="color:var(--destructive);border-color:rgba(239,68,68,0.3);gap:4px" onclick="resolveAction(\\'' + safe + '\\', \\'reject\\')">Deny</button>';
          actionHtml += '<button class="btn btn-sm" style="background:var(--success);color:#fff;gap:4px" onclick="resolveAction(\\'' + safe + '\\', \\'approve\\')">Approve</button>';
          actionHtml += '</div>';
        }
        actionHtml += '</div>';
      });
      if (!actionHtml) actionHtml = '<div class="card" style="padding:24px;text-align:center;color:var(--muted);font-size:14px">No pending actions.</div>';

      return \`
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
          <div style="display:flex;align-items:center;gap:16px">
            <div>
              <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.5px;color:var(--fg)">Calendar</h1>
              \${accountEmail ? '<p style="font-size:13px;color:var(--muted);margin-top:2px">' + escapeHtml(accountEmail) + '</p>' : ''}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" style="color:var(--destructive);border-color:rgba(239,68,68,0.3)" onclick="if(confirm('Disconnect Calendar?')){disconnectSource('google_calendar')}">Disconnect</button>
        </div>

        <div class="card" style="padding:20px;margin-bottom:16px">
          <label style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:14px">Quick Filters</label>
          \${renderCalendarFilterCards(calFilters)}
        </div>

        <div class="gmail-grid">
          <div class="gmail-grid-left">
            <div class="action-review-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted)"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <h2 style="margin:0">Agent Access Preview</h2>
            </div>
            <div class="card" style="padding:0;overflow:hidden">
              <div class="email-list-header">
                <span class="stat">Showing: <strong>\${visibleEvents.length}</strong> events</span>
                \${calConnected && !state.eventsLoading ? '<button onclick="refreshCalendarEvents()" style="margin-left:auto;background:none;border:1px solid var(--border);border-radius:4px;padding:2px 10px;font-size:12px;color:var(--muted);cursor:pointer">Refresh</button>' : ''}
              </div>
              \${state.eventsLoading
                ? '<div style="padding:40px;text-align:center"><p style="color:var(--muted);font-size:14px">Loading events...</p></div>'
                : (eventListHtml || '<p class="empty" style="padding:40px">No events found.</p>')}
            </div>
          </div>

          <div class="gmail-grid-right">
            <div class="action-review-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted)"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <h2 style="margin:0">Agent Action Review</h2>
              \${pendingCount ? '<span class="nav-badge">' + pendingCount + '</span>' : ''}
            </div>
            \${actionHtml}
          </div>
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
          repoHtml += '<span style="font-size:14px;color:#888">' + enabledCount + '/' + ownerRepos.length + ' selected</span>';
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
            if (repo.private) repoHtml += '<span class="status disconnected" style="font-size:14px;padding:2px 6px">private</span>';
            if (repo.description) repoHtml += '<span style="font-size:14px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px">' + escapeHtml(repo.description) + '</span>';
            repoHtml += '<span class="repo-chevron ' + (exp ? 'open' : '') + '">&#9654;</span>';
            repoHtml += '</div>';
            repoHtml += '<div class="repo-perms ' + (exp ? 'show' : '') + '">';
            repoHtml += '<div style="display:flex;align-items:center;gap:6px;padding:8px 0">';
            repoHtml += '<span style="font-size:14px;font-weight:700;color:var(--fg)">Contents</span>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasCodeRead) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'contents:read\\', this.checked)"><label>read</label></div>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasCodeWrite) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'contents:write\\', this.checked)"><label>write</label></div>';
            repoHtml += '<span style="color:#ddd;margin:0 4px">|</span>';
            repoHtml += '<span style="font-size:14px;font-weight:700;color:var(--fg)">Issues</span>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasIssuesRead) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'issues:read\\', this.checked)"><label>read</label></div>';
            repoHtml += '<div class="toggle" style="margin:0"><input type="checkbox" ' + chk(hasIssuesWrite) + ' onchange="toggleRepoPerm(\\'' + safe + '\\', \\'issues:write\\', this.checked)"><label>write</label></div>';
            repoHtml += '<span style="color:#ddd;margin:0 4px">|</span>';
            repoHtml += '<span style="font-size:14px;font-weight:700;color:var(--fg)">Pull Requests</span>';
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
            ? '<div style="display:flex;align-items:center;gap:10px"><span class="status-dot status-dot-connected"></span><span class="status connected">Connected</span></div>' +
              (ghAccount && ghAccount.login ? '<p style="margin-top:8px;font-size:14px">Signed in as <strong class="font-mono">@' + ghAccount.login + '</strong></p>' : '') +
              '<div class="actions"><button class="btn btn-danger btn-sm" onclick="disconnectSource(\\'github\\')">Disconnect</button></div>'
            : '<div style="display:flex;align-items:center;gap:10px"><span class="status-dot status-dot-disconnected"></span><span class="status disconnected">' + (github?.enabled ? 'Not connected' : 'Not configured') + '</span></div>' +
              '<div class="actions"><button class="btn btn-primary" onclick="startOAuth(\\'github\\')">Connect GitHub</button></div>'
          }
        </div>

        \${ghConnected ? '<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Repositories <span class="save-flash" id="github-flash">Saved</span></h2><button class="btn btn-outline btn-sm" onclick="fetchGithubRepos()">Refresh repos</button></div>' +
          '<div style="display:flex;align-items:center;gap:6px;padding:10px 14px;background:var(--sidebar-bg);border-radius:6px;margin-bottom:12px">' +
            '<span style="font-size:14px;font-weight:700;color:var(--fg);white-space:nowrap">Contents</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-code-read" checked><label for="bulk-code-read" style="font-size:14px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-code-write"><label for="bulk-code-write" style="font-size:14px">write</label></div>' +
            '<span style="color:#ddd;margin:0 4px">|</span>' +
            '<span style="font-size:14px;font-weight:700;color:var(--fg);white-space:nowrap">Issues</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-issues-read" checked><label for="bulk-issues-read" style="font-size:14px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-issues-write"><label for="bulk-issues-write" style="font-size:14px">write</label></div>' +
            '<span style="color:#ddd;margin:0 4px">|</span>' +
            '<span style="font-size:14px;font-weight:700;color:var(--fg);white-space:nowrap">Pull Requests</span>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-prs-read" checked><label for="bulk-prs-read" style="font-size:14px">read</label></div>' +
            '<div class="toggle" style="margin:0"><input type="checkbox" id="bulk-prs-write"><label for="bulk-prs-write" style="font-size:14px">write</label></div>' +
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
          <h2>Audit Log</h2>
          \${state.audit.length ? '<table><tr><th>Time</th><th>Event</th><th>Source</th><th>Details</th><th>Response</th></tr>' +
            state.audit.map(e => {
              const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
              const resp = d.responseSummary || '';
              const detailsCopy = Object.assign({}, d);
              delete detailsCopy.responseSummary;
              const respCell = resp
                ? '<details style="font-size:13px;max-width:500px;cursor:pointer"><summary style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px">' + formatResponsePreview(resp) + '</summary>' + formatResponseDetails(resp) + '</details>'
                : '-';
              return '<tr><td style="font-size:14px">' + new Date(e.timestamp).toLocaleString() + '</td><td>' + e.event + '</td><td>' + (e.source || '-') + '</td><td style="font-size:14px;max-width:300px;overflow-wrap:break-word;word-break:break-word">' + JSON.stringify(detailsCopy).slice(0,200) + (JSON.stringify(detailsCopy).length > 200 ? '...' : '') + '</td><td>' + respCell + '</td></tr>';
            }).join('') +
            '</table>' : '<p class="empty">No audit entries.</p>'}
        </div>
      \`;
    }

    function toggleEmailExpand(emailId) {
      state.expandedEmail = state.expandedEmail === emailId ? null : emailId;
      render();
    }

    function toggleEditAction(actionId) {
      state.editingAction = state.editingAction === actionId ? null : actionId;
      render();
    }

    // --- Quick filter functions ---
    function renderFilterCards(filters) {
      var types = state.filterTypes || {};
      var typeKeys = Object.keys(types);
      if (!typeKeys.length) return '<p class="empty">Loading filter types...</p>';

      var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
      typeKeys.forEach(function(typeKey) {
        var meta = types[typeKey];
        // Find existing filter of this type for gmail
        var existing = filters.find(function(f) { return f.type === typeKey; });
        var isEnabled = existing ? !!existing.enabled : false;
        var value = existing ? (existing.value || '') : '';
        var filterId = existing ? existing.id : '';
        var safeType = escapeAttr(typeKey);
        var needsValue = meta.needsValue;

        html += '<div class="card" style="padding:14px;margin:0;border:1px solid ' + (isEnabled ? 'rgba(15,160,129,0.3)' : 'var(--border)') + ';transition:border-color 0.2s">';
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:' + (needsValue ? '10px' : '0') + '">';
        // Toggle switch
        html += '<label style="position:relative;display:inline-block;width:36px;height:20px;margin:0;cursor:pointer;flex-shrink:0">';
        html += '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleFilter(&quot;' + safeType + '&quot;, this.checked, &quot;' + escapeAttr(filterId) + '&quot;)" style="opacity:0;width:0;height:0">';
        html += '<span style="position:absolute;inset:0;background:' + (isEnabled ? 'var(--primary)' : '#ccc') + ';border-radius:10px;transition:background 0.2s"></span>';
        html += '<span style="position:absolute;left:' + (isEnabled ? '18px' : '2px') + ';top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2)"></span>';
        html += '</label>';
        html += '<span style="font-size:14px;font-weight:500;color:' + (isEnabled ? 'var(--fg)' : 'var(--muted)') + '">' + escapeHtml(meta.label) + '</span>';
        html += '</div>';
        if (needsValue) {
          html += '<input type="' + (typeKey === 'time_after' ? 'date' : 'text') + '" id="filter-val-' + safeType + '" value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(meta.placeholder) + '" onchange="updateFilterValue(&quot;' + safeType + '&quot;, this.value, &quot;' + escapeAttr(filterId) + '&quot;)" style="width:100%;font-size:13px;padding:6px 10px">';
        }
        html += '</div>';
      });
      html += '</div>';
      return html;
    }

    function renderCalendarFilterCards(filters) {
      var types = state.filterTypes || {};
      var typeKeys = Object.keys(types).filter(function(k) { return k === 'time_after'; }); // Only time_after for calendar for now
      if (!typeKeys.length) return '<p class="empty">Loading filter types...</p>';

      var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
      typeKeys.forEach(function(typeKey) {
        var meta = types[typeKey];
        var label = meta.label;
        if (typeKey === 'time_after') label = 'Only events after';

        var existing = filters.find(function(f) { return f.type === typeKey; });
        var isEnabled = existing ? !!existing.enabled : false;
        var value = existing ? (existing.value || '') : '';
        var filterId = existing ? existing.id : '';
        var safeType = escapeAttr(typeKey);
        var needsValue = meta.needsValue;

        html += '<div class="card" style="padding:14px;margin:0;border:1px solid ' + (isEnabled ? 'rgba(15,160,129,0.3)' : 'var(--border)') + ';transition:border-color 0.2s">';
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:' + (needsValue ? '10px' : '0') + '">';
        html += '<label style="position:relative;display:inline-block;width:36px;height:20px;margin:0;cursor:pointer;flex-shrink:0">';
        html += '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleCalendarFilter(&quot;' + safeType + '&quot;, this.checked, &quot;' + escapeAttr(filterId) + '&quot;)" style="opacity:0;width:0;height:0">';
        html += '<span style="position:absolute;inset:0;background:' + (isEnabled ? 'var(--primary)' : '#ccc') + ';border-radius:10px;transition:background 0.2s"></span>';
        html += '<span style="position:absolute;left:' + (isEnabled ? '18px' : '2px') + ';top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2)"></span>';
        html += '</label>';
        html += '<span style="font-size:14px;font-weight:500;color:' + (isEnabled ? 'var(--fg)' : 'var(--muted)') + '">' + escapeHtml(label) + '</span>';
        html += '</div>';
        if (needsValue) {
          html += '<input type="' + (typeKey === 'time_after' ? 'date' : 'text') + '" id="cal-filter-val-' + safeType + '" value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(meta.placeholder) + '" onchange="updateCalendarFilterValue(&quot;' + safeType + '&quot;, this.value, &quot;' + escapeAttr(filterId) + '&quot;)" style="width:100%;font-size:13px;padding:6px 10px">';
        }
        html += '</div>';
      });
      html += '</div>';
      return html;
    }

    async function toggleCalendarFilter(type, enabled, existingId) {
      var valEl = document.getElementById('cal-filter-val-' + type);
      var value = valEl ? valEl.value : '';
      await fetch('/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existingId || undefined, source: 'google_calendar', type: type, value: value, enabled: enabled ? 1 : 0 })
      });
      state.realEvents = null;
      await fetchData();
    }

    async function updateCalendarFilterValue(type, value, existingId) {
      var filter = (state.filters || []).find(function(f) { return f.type === type && f.source === 'google_calendar'; });
      await fetch('/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existingId || undefined, source: 'google_calendar', type: type, value: value, enabled: filter ? filter.enabled : 0 })
      });
      if (filter && filter.enabled) {
        state.realEvents = null;
        await fetchData();
      } else {
        var filtersData = await fetch('/api/filters').then(function(r) { return r.json(); });
        state.filters = filtersData.filters || [];
      }
    }

    async function toggleFilter(type, enabled, existingId) {
      var valEl = document.getElementById('filter-val-' + type);
      var value = valEl ? valEl.value : '';
      await fetch('/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existingId || undefined, source: 'gmail', type: type, value: value, enabled: enabled ? 1 : 0 })
      });
      // Refresh emails to reflect new filters
      state.realEmails = null;
      await fetchData();
    }

    async function updateFilterValue(type, value, existingId) {
      // Only save if filter is currently enabled
      var filter = (state.filters || []).find(function(f) { return f.type === type && f.source === 'gmail'; });
      await fetch('/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existingId || undefined, source: 'gmail', type: type, value: value, enabled: filter ? filter.enabled : 0 })
      });
      if (filter && filter.enabled) {
        state.realEmails = null;
        await fetchData();
      } else {
        // Still update local state so the value is saved
        var filtersData = await fetch('/api/filters').then(function(r) { return r.json(); });
        state.filters = filtersData.filters || [];
      }
    }

    async function sendAction(actionId) {
      var editTo = document.getElementById('edit-to-' + actionId);
      if (editTo) {
        await fetch('/api/staging/' + actionId + '/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_data: {
            to: document.getElementById('edit-to-' + actionId).value,
            subject: document.getElementById('edit-subj-' + actionId).value,
            body: document.getElementById('edit-body-' + actionId).value,
            send: true
          }})
        });
      }
      await resolveAction(actionId, 'approve');
    }

    // --- Toggle repo expand/collapse ---
    function toggleRepo(repo) {
      state.expandedRepos[repo] = !state.expandedRepos[repo];
      render();
    }

    function saveGithub() {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(function() {
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
      if (el) { el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 1500); }
      // Also flash sidebar footer
      var sf = document.getElementById('sidebar-flash');
      if (sf) { sf.classList.add('show'); setTimeout(function() { sf.classList.remove('show'); }, 1500); }
    }

    // --- OAuth actions ---
    function startOAuth(source) {
      window.location.href = '/oauth/' + source + '/start';
    }

    async function disconnectSource(source) {
      if (!confirm('Disconnect ' + source + '? You will need to re-authorize.')) return;
      await fetch('/oauth/' + source + '/disconnect', { method: 'POST' });
      if (source === 'gmail') {
        state.realEmails = null;
        state.emailsLoading = false;
      }
      if (source === 'google_calendar') {
        state.realEvents = null;
        state.eventsLoading = false;
      }
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

    function formatResponsePreview(raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
          var items = parsed.data;
          var first = items[0].data || items[0];
          if (first.title || first.author_email || first.subject || first.author_name) {
            var total = (parsed.meta && parsed.meta.itemsReturned) || items.length;
            var subjects = items.map(function(item) {
              var d = item.data || item;
              return d.title || d.subject || '(no subject)';
            });
            var preview = total + ' item(s)';
            if (total > items.length) preview += ' (showing ' + items.length + ')';
            preview += ': ' + subjects.join(', ');
            return escapeHtml(preview);
          }
        }
      } catch(e) {}
      return escapeHtml(raw.slice(0, 160)) + (raw.length > 160 ? '...' : '');
    }

    function formatResponseDetails(raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
          var items = parsed.data;
          var first = items[0].data || items[0];
          if (first.title || first.author_email || first.subject || first.author_name) {
            var html = '<table style="width:100%;font-size:12px;border-collapse:collapse;margin:4px 0">';
            html += '<tr style="background:var(--bg)"><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">From</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Subject</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Date</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Preview</th></tr>';
            items.forEach(function(item) {
              var d = item.data || item;
              var from = d.author_email || d.author_name || d.from || '';
              var subject = d.title || d.subject || '';
              var preview = d.snippet || (d.body ? String(d.body).slice(0, 120) : '') || '';
              var dateStr = d.date || item.timestamp || '';
              var dateFmt = dateStr ? new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
              html += '<tr><td style="padding:4px 8px;border-bottom:1px solid var(--border);white-space:nowrap">' + escapeHtml(from) + '</td><td style="padding:4px 8px;border-bottom:1px solid var(--border)">' + escapeHtml(subject) + '</td><td style="padding:4px 8px;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--muted)">' + escapeHtml(dateFmt) + '</td><td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--muted)">' + escapeHtml(preview.slice(0, 120)) + '</td></tr>';
            });
            html += '</table>';
            if (parsed.meta) {
              var total = parsed.meta.itemsReturned || 0;
              var shown = items.length;
              var msg = shown < total
                ? 'Showing ' + shown + ' of ' + total + ' items returned (' + parsed.meta.itemsFetched + ' fetched)'
                : total + ' of ' + parsed.meta.itemsFetched + ' items returned';
              html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + escapeHtml(msg) + '</div>';
            }
            return html;
          }
        }
      } catch(e) {}
      return '<pre style="white-space:pre-wrap;word-break:break-all;margin:4px 0;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;max-height:300px;overflow:auto;font-size:11px">' + raw.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
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

    async function clearAuditLog() {
      if (!confirm('Delete all audit log history? This cannot be undone.')) return;
      await fetch('/api/audit', { method: 'DELETE' });
      state.audit = [];
      render();
    }
    window.clearAuditLog = clearAuditLog;

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

    async function logout() {
      await fetch('/api/logout', { method: 'POST' });
      window.location.reload();
    }

    // Make functions available globally
    window.logout = logout;
    window.startOAuth = startOAuth;
    window.disconnectSource = disconnectSource;
    window.resolveAction = resolveAction;
    window.approveAction = approveAction;
    window.editAction = editAction;
    window.cancelEdit = cancelEdit;
    window.toggleRepo = toggleRepo;
    window.saveGithub = saveGithub;
    window.chk = chk;
    window.fetchGithubRepos = fetchGithubRepos;
    window.toggleRepoEnabled = toggleRepoEnabled;
    window.toggleRepoPerm = toggleRepoPerm;
    window.selectAllOwner = selectAllOwner;
    window.applyBulkPerms = applyBulkPerms;
    window.toggleEmailExpand = toggleEmailExpand;
    window.refreshEmails = function() {
      state.realEmails = null;
      state.emailsError = null;
      state.emailsLoading = false;
      render(); // Show loading state immediately
      fetchData();
    };
    window.refreshCalendarEvents = function() {
      state.realEvents = null;
      state.eventsError = null;
      state.eventsLoading = false;
      render(); // Show loading state immediately
      fetchData();
    };
    window.toggleEditAction = toggleEditAction;
    window.toggleFilter = toggleFilter;
    window.updateFilterValue = updateFilterValue;
    window.renderFilterCards = renderFilterCards;
    window.toggleCalendarFilter = toggleCalendarFilter;
    window.updateCalendarFilterValue = updateCalendarFilterValue;
    window.renderCalendarFilterCards = renderCalendarFilterCards;
    window.sendAction = sendAction;

    // Handle OAuth redirect results
    (function handleOAuthResult() {
      var params = new URLSearchParams(window.location.search);
      var success = params.get('oauth_success');
      var error = params.get('oauth_error');
      if (success) {
        switchTab(success);
        window.history.replaceState({}, '', '/');
      }
      if (error) {
        alert('OAuth error: ' + error);
        window.history.replaceState({}, '', '/');
      }
    })();

    // --- Auth: signup vs login form ---
    var isSignup = false;

    function handleAuthSubmit(e) {
      e.preventDefault();
      var email = document.getElementById('auth-email').value;
      var password = document.getElementById('auth-password').value;
      var errorEl = document.getElementById('login-error');
      var btn = document.getElementById('auth-submit');
      errorEl.textContent = '';
      btn.disabled = true;
      btn.textContent = isSignup ? 'Creating account...' : 'Signing in...';

      var endpoint = isSignup ? '/auth/signup' : '/auth/login';
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(res) {
        btn.disabled = false;
        btn.textContent = isSignup ? 'Create Account' : 'Sign In';
        if (res.data.ok) {
          document.getElementById('login-screen').style.display = 'none';
          document.getElementById('app').style.display = 'flex';
          fetchData();
        } else {
          errorEl.textContent = res.data.error || 'Authentication failed';
        }
      }).catch(function() {
        btn.disabled = false;
        btn.textContent = isSignup ? 'Create Account' : 'Sign In';
        errorEl.textContent = 'Network error. Please try again.';
      });
      return false;
    }
    window.handleAuthSubmit = handleAuthSubmit;

    // Check auth on load
    fetch('/api/auth/status').then(function(r) { return r.json(); }).then(function(data) {
      if (data.authenticated) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        fetchData();
      } else {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
        isSignup = !data.hasUsers;
        document.getElementById('login-subtitle').textContent = isSignup ? 'Create your account' : 'Sign in to continue';
        document.getElementById('auth-submit').textContent = isSignup ? 'Create Account' : 'Sign In';
      }
    });
  </script>
</body>
</html>`;
}
