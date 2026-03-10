import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '../database/datastore.js';
import type { ConnectorRegistry } from './connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { TokenManager } from './auth/token-manager.js';
import { AuditLog } from './audit/log.js';
import type { QuickFilter } from './filters.js';
import { quickFiltersToSteps, executePipeline, validatePipeline } from './pipeline/index.js';
import type { PipelineDefinition } from './pipeline/index.js';

export interface AppApiDeps {
  store: DataStore;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  tokenManager: TokenManager;
}

export function createAppApi(deps: AppApiDeps): Hono {
  const app = new Hono();
  const auditLog = new AuditLog(deps.store);

  // POST /pull
  app.post('/pull', async (c) => {
    console.log('[app-api] /pull handler entered');
    const body = await c.req.json();
    console.log('[app-api] /pull body:', JSON.stringify(body));
    const { source, purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    if (!source) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: source' } }, 400);
    }

    const sourceConfig = deps.config.sources[source];
    if (!sourceConfig) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `Unknown source: "${source}"` } }, 404);
    }

    // Fetch live from connector
    const connector = deps.connectorRegistry.get(source);
    if (!connector) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `No connector for source: "${source}"` } }, 404);
    }

    if (!await deps.tokenManager.hasToken(source)) {
      return c.json({ ok: false, error: { code: 'SOURCE_NOT_CONNECTED', message: `Source "${source}" is not connected. Complete OAuth setup in the GUI first.` } }, 400);
    }

    const boundary = sourceConfig.boundary ?? {};
    const params: Record<string, unknown> = {};
    if (body.query) params.query = body.query;
    if (body.limit) params.limit = body.limit;
    console.log('[app-api] /pull source=%s query=%s limit=%s', source, body.query ?? '(none)', body.limit ?? '(default)');
    const rows = await connector.fetch(boundary, Object.keys(params).length > 0 ? params : undefined);

    // Load enabled filters, translate to pipeline steps, and execute
    const filters = await deps.store.getEnabledFiltersBySource(source) as QuickFilter[];
    const steps = quickFiltersToSteps(filters);
    const pipelineResult = executePipeline(rows, steps);
    const filtered = pipelineResult.rows;

    // Log to audit
    await auditLog.logPull(source, purpose, filtered.length, 'agent');

    return c.json({
      ok: true,
      data: filtered,
      meta: {
        itemsFetched: rows.length,
        itemsReturned: filtered.length,
        pipelineSteps: pipelineResult.meta.stepsApplied,
      },
    });
  });

  // POST /pull/pipeline
  app.post('/pull/pipeline', async (c) => {
    const body = await c.req.json();
    const { purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    // Check if custom pipelines are allowed
    const pipelineConfig = deps.config.pipeline ?? {};
    if (!pipelineConfig.allow_custom_pipelines) {
      return c.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Custom pipelines are not enabled. Set pipeline.allow_custom_pipelines: true in config.' } }, 403);
    }

    // Parse and validate the pipeline definition
    const def = body as PipelineDefinition;
    if (!def.pipeline || !def.steps) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required fields: pipeline, steps' } }, 400);
    }

    const maxSteps = pipelineConfig.max_steps ?? 20;
    if (def.steps.length > maxSteps) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: `Pipeline exceeds max_steps limit (${maxSteps})` } }, 400);
    }

    const validation = validatePipeline(def);
    if (!validation.valid) {
      return c.json({ ok: false, error: { code: 'INVALID_PIPELINE', message: 'Pipeline validation failed', details: validation.errors } }, 400);
    }

    // Check required operators
    const requiredOps = pipelineConfig.required_operators ?? [];
    const stepOps = new Set(def.steps.map((s) => s.op));
    const missingOps = requiredOps.filter((op) => !stepOps.has(op));
    if (missingOps.length > 0) {
      return c.json({ ok: false, error: { code: 'MISSING_REQUIRED_OPERATORS', message: `Pipeline must include operators: ${missingOps.join(', ')}` } }, 400);
    }

    // Find pull_source step to determine which source to fetch from
    const pullStep = def.steps.find((s) => s.op === 'pull_source');
    if (!pullStep || pullStep.op !== 'pull_source') {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Pipeline must include a pull_source step' } }, 400);
    }

    const source = pullStep.source;
    const sourceConfig = deps.config.sources[source];
    if (!sourceConfig) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `Unknown source: "${source}"` } }, 404);
    }

    const connector = deps.connectorRegistry.get(source);
    if (!connector) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `No connector for source: "${source}"` } }, 404);
    }

    if (!await deps.tokenManager.hasToken(source)) {
      return c.json({ ok: false, error: { code: 'SOURCE_NOT_CONNECTED', message: `Source "${source}" is not connected. Complete OAuth setup in the GUI first.` } }, 400);
    }

    // Fetch data
    const boundary = sourceConfig.boundary ?? {};
    const params: Record<string, unknown> = {};
    if (pullStep.query) params.query = pullStep.query;
    const rows = await connector.fetch(boundary, Object.keys(params).length > 0 ? params : undefined);

    // Also apply owner's QuickFilters on top of the agent's pipeline
    const filters = await deps.store.getEnabledFiltersBySource(source) as QuickFilter[];
    const ownerSteps = quickFiltersToSteps(filters);
    const allSteps = [...ownerSteps, ...def.steps.filter((s) => s.op !== 'pull_source')];

    const pipelineResult = executePipeline(rows, allSteps);

    // Log to audit
    await auditLog.logPull(source, purpose, pipelineResult.rows.length, 'agent');

    return c.json({
      ok: true,
      data: pipelineResult.rows,
      meta: {
        pipeline: def.pipeline,
        itemsFetched: rows.length,
        itemsReturned: pipelineResult.meta.outputCount,
        pipelineSteps: pipelineResult.meta.stepsApplied,
        piiRedactions: pipelineResult.meta.piiRedactions,
      },
    });
  });

  // POST /propose
  app.post('/propose', async (c) => {
    const body = await c.req.json();
    const { source, action_type, action_data, purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    if (!source || !action_type) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required fields: source, action_type' } }, 400);
    }

    // Insert into staging
    const actionId = `act_${randomUUID().slice(0, 12)}`;
    await deps.store.insertStagingAction({
      actionId,
      manifestId: '',
      source,
      actionType: action_type,
      actionData: JSON.stringify(action_data ?? {}),
      purpose,
    });

    // Log to audit
    await auditLog.logActionProposed(actionId, source, action_type, purpose, 'agent');

    return c.json({
      ok: true,
      actionId,
      status: 'pending_review',
    });
  });

  // GET /sources — discover which sources are connected (have OAuth tokens)
  app.get('/sources', async (c) => {
    const sources: Record<string, { connected: boolean }> = {};
    for (const [name] of deps.connectorRegistry) {
      const hasToken = await deps.tokenManager.hasToken(name);
      sources[name] = { connected: hasToken };
    }
    return c.json({ ok: true, sources });
  });

  return app;
}
