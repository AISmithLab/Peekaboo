import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translatePolicy } from './translate.js';

describe('translatePolicy', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('returns NO_API_KEY when env var is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await translatePolicy('show recent emails', 'gmail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('NO_API_KEY');
    }
  });

  it('returns parsed manifest on valid Claude response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const manifestDsl = `
@purpose: "Filter recent emails from gmail"
@graph: pull_emails -> filter_time
pull_emails: pull { source: "gmail", type: "email" }
filter_time: filter { field: "timestamp", op: "gt", value: "2025-01-01" }
`.trim();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: manifestDsl }],
      }),
    } as Response);

    const result = await translatePolicy('show emails from this year', 'gmail');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.manifest.purpose).toBe('Filter recent emails from gmail');
      expect(result.result.manifest.operators.size).toBe(2);
      expect(result.result.rawManifest).toBe(manifestDsl);
    }
  });

  it('strips markdown fences from response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const manifestDsl = `@purpose: "Test"
@graph: pull_emails
pull_emails: pull { source: "gmail", type: "email" }`;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```\n' + manifestDsl + '\n```' }],
      }),
    } as Response);

    const result = await translatePolicy('test', 'gmail');
    expect(result.ok).toBe(true);
  });

  it('returns PARSE_ERROR on invalid DSL', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'this is not valid manifest DSL at all' }],
      }),
    } as Response);

    const result = await translatePolicy('do something', 'gmail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('PARSE_ERROR');
    }
  });

  it('returns UNSUPPORTED_OPERATORS for unknown operator types', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const manifestDsl = `
@purpose: "Test with unknown op"
@graph: pull_emails -> magic_op
pull_emails: pull { source: "gmail", type: "email" }
magic_op: teleport { destination: "moon" }
`.trim();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: manifestDsl }],
      }),
    } as Response);

    const result = await translatePolicy('teleport my emails', 'gmail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('UNSUPPORTED_OPERATORS');
      expect(result.unsupportedOperators).toContain('teleport');
    }
  });

  it('returns API_ERROR on non-ok response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as Response);

    const result = await translatePolicy('test', 'gmail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('API_ERROR');
      expect(result.message).toContain('429');
    }
  });
});
