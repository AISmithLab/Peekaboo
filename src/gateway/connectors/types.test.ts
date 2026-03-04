import { describe, it, expect } from 'vitest';
import type {
  DataRow,
  SourceConnector,
  ActionResult,
} from './types.js';

describe('DataRow and Connector Types', () => {
  it('Gmail DataRow type-checks correctly', () => {
    const row: DataRow = {
      source: 'gmail',
      source_item_id: 'msg_abc123',
      type: 'email',
      timestamp: '2026-02-20T10:00:00Z',
      data: {
        title: 'Q4 Report Draft',
        body: 'Revenue was $2.3M...',
        author_name: 'Alice',
        author_email: 'alice@company.com',
        participants: [{ name: 'Bob', email: 'bob@co.com', role: 'to' }],
        labels: ['inbox', 'important'],
        url: 'https://mail.google.com/mail/u/0/#inbox/msg_abc123',
        attachments: [{ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }],
        threadId: 'thread_1',
        isUnread: true,
        snippet: 'Revenue was $2.3M...',
      },
    };

    expect(row.source).toBe('gmail');
    expect(row.data.title).toBe('Q4 Report Draft');
  });

  it('GitHub DataRow type-checks correctly', () => {
    const row: DataRow = {
      source: 'github',
      source_item_id: 'myorg/frontend#123',
      type: 'issue',
      timestamp: '2026-02-19T15:00:00Z',
      data: {
        title: 'Fix login bug',
        body: 'The login form fails when...',
        author_name: 'bob',
        author_url: 'https://github.com/bob',
        labels: ['bug', 'P0'],
        url: 'https://github.com/myorg/frontend/issues/123',
        repo: 'myorg/frontend',
        number: 123,
        state: 'open',
      },
    };

    expect(row.source).toBe('github');
    expect(row.data.repo).toBe('myorg/frontend');
    expect(row.data.number).toBe(123);
  });

  it('data map can hold any shape — nested objects, arrays, strings, numbers', () => {
    const row: DataRow = {
      source: 'custom',
      source_item_id: 'item_1',
      type: 'misc',
      timestamp: '2026-02-20T00:00:00Z',
      data: {
        stringField: 'hello',
        numberField: 42,
        boolField: true,
        arrayField: [1, 'two', { three: 3 }],
        nestedObject: {
          a: { b: { c: 'deep' } },
        },
        nullField: null,
      },
    };

    expect(row.data.stringField).toBe('hello');
    expect(row.data.numberField).toBe(42);
    expect(row.data.boolField).toBe(true);
    expect(row.data.arrayField).toEqual([1, 'two', { three: 3 }]);
    expect(row.data.nestedObject).toEqual({ a: { b: { c: 'deep' } } });
  });

  it('mock connector implementing SourceConnector compiles without errors', () => {
    const mockConnector: SourceConnector = {
      name: 'mock',
      async fetch(_boundary, _params) {
        return [
          {
            source: 'mock',
            source_item_id: '1',
            type: 'item',
            timestamp: '2026-01-01T00:00:00Z',
            data: { title: 'Test' },
          },
        ];
      },
      async executeAction(_type, _data): Promise<ActionResult> {
        return { success: true, message: 'Done' };
      },
    };

    expect(mockConnector.name).toBe('mock');
    expect(typeof mockConnector.fetch).toBe('function');
    expect(typeof mockConnector.executeAction).toBe('function');
  });
});
