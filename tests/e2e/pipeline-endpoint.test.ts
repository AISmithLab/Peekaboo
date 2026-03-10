import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, request, cleanup, makeConfig } from './helpers.js';
import type { DataRow } from '../../src/connectors/types.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

function makeConfigWithPipeline(opts: { allow?: boolean; required_operators?: string[]; max_steps?: number } = {}) {
  const config = makeConfig();
  (config as Record<string, unknown>).pipeline = {
    allow_custom_pipelines: opts.allow ?? true,
    required_operators: opts.required_operators ?? [],
    max_steps: opts.max_steps ?? 20,
  };
  return config;
}

describe('E2E: POST /app/v1/pull/pipeline', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;

  describe('when custom pipelines are enabled', () => {
    beforeEach(async () => {
      ({ app, db, tmpDir } = await setupE2eApp(undefined, makeConfigWithPipeline()));
    });
    afterEach(() => cleanup(db, tmpDir));

    it('executes a valid pipeline and returns filtered data', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'test_summary',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'select_fields', fields: ['title', 'snippet'] },
          { op: 'limit', max: 2 },
        ],
        purpose: 'Test pipeline execution',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; data: DataRow[]; meta: Record<string, unknown> };
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(2);
      // select_fields should only keep title and snippet
      for (const row of json.data) {
        expect(row.data.title).toBeDefined();
        expect(row.data.body).toBeUndefined();
        expect(row.data.author_email).toBeUndefined();
      }
      expect(json.meta.pipeline).toBe('test_summary');
      expect(json.meta.pipelineSteps).toContain('select_fields');
      expect(json.meta.pipelineSteps).toContain('limit');
    });

    it('applies owner QuickFilters on top of agent pipeline', async () => {
      // Add a QuickFilter that hides the 'snippet' field
      db.prepare(
        "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
      ).run('f1', 'gmail', 'hide_field', 'snippet');

      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'test_with_owner_filter',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'select_fields', fields: ['title', 'snippet'] },
        ],
        purpose: 'Test owner filters applied on top',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; data: DataRow[] };
      expect(json.ok).toBe(true);
      // Owner's hide_field should remove snippet even though agent requested it
      for (const row of json.data) {
        expect(row.data.snippet).toBeUndefined();
        expect(row.data.title).toBeDefined();
      }
    });

    it('applies redact_pii and reports redaction count', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'test_redact',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'redact_pii' },
        ],
        purpose: 'Test PII redaction',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; data: DataRow[]; meta: { piiRedactions: number } };
      expect(json.ok).toBe(true);
      expect(json.meta.piiRedactions).toBeGreaterThan(0);
      // SSNs should be redacted
      const body = json.data[0].data.body as string;
      expect(body).not.toContain('123-45-6789');
      expect(body).toContain('[REDACTED]');
    });

    it('rejects pipeline without pull_source step', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'no_source',
        steps: [{ op: 'select_fields', fields: ['title'] }],
        purpose: 'Test missing pull_source',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: { code: string } };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('BAD_REQUEST');
    });

    it('rejects pipeline with invalid step', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'bad_step',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'select_fields', fields: [] },
        ],
        purpose: 'Test invalid step',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: { code: string } };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_PIPELINE');
    });

    it('rejects pipeline for unknown source', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'unknown_src',
        steps: [
          { op: 'pull_source', source: 'slack' },
          { op: 'limit', max: 5 },
        ],
        purpose: 'Test unknown source',
      });

      expect(res.status).toBe(404);
    });

    it('rejects when purpose is missing', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'no_purpose',
        steps: [{ op: 'pull_source', source: 'gmail' }],
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: { message: string } };
      expect(json.error.message).toContain('purpose');
    });
  });

  describe('when custom pipelines are disabled', () => {
    beforeEach(async () => {
      ({ app, db, tmpDir } = await setupE2eApp(undefined, makeConfigWithPipeline({ allow: false })));
    });
    afterEach(() => cleanup(db, tmpDir));

    it('returns 403 FORBIDDEN', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'blocked',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'limit', max: 5 },
        ],
        purpose: 'Should be forbidden',
      });

      expect(res.status).toBe(403);
      const json = await res.json() as { ok: boolean; error: { code: string } };
      expect(json.error.code).toBe('FORBIDDEN');
    });
  });

  describe('with required_operators', () => {
    beforeEach(async () => {
      ({ app, db, tmpDir } = await setupE2eApp(undefined, makeConfigWithPipeline({
        allow: true,
        required_operators: ['redact_pii'],
      })));
    });
    afterEach(() => cleanup(db, tmpDir));

    it('rejects pipeline missing required operator', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'no_redact',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'select_fields', fields: ['title'] },
        ],
        purpose: 'Test required operators',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: { code: string; message: string } };
      expect(json.error.code).toBe('MISSING_REQUIRED_OPERATORS');
      expect(json.error.message).toContain('redact_pii');
    });

    it('accepts pipeline with required operator included', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'with_redact',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'redact_pii' },
          { op: 'select_fields', fields: ['title'] },
        ],
        purpose: 'Test required operators satisfied',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });

  describe('with max_steps limit', () => {
    beforeEach(async () => {
      ({ app, db, tmpDir } = await setupE2eApp(undefined, makeConfigWithPipeline({
        allow: true,
        max_steps: 3,
      })));
    });
    afterEach(() => cleanup(db, tmpDir));

    it('rejects pipeline exceeding max_steps', async () => {
      const res = await request(app, 'POST', '/app/v1/pull/pipeline', {
        pipeline: 'too_many_steps',
        steps: [
          { op: 'pull_source', source: 'gmail' },
          { op: 'time_window', after: '2026-01-01T00:00:00Z' },
          { op: 'select_fields', fields: ['title'] },
          { op: 'limit', max: 10 },
        ],
        purpose: 'Test max_steps',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: { message: string } };
      expect(json.error.message).toContain('max_steps');
    });
  });
});
