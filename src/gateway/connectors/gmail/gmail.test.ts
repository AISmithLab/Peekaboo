import { describe, it, expect } from 'vitest';
import { mapGmailMessage } from './connector.js';
import type { gmail_v1 } from 'googleapis';

function makeGmailMessage(overrides?: Partial<gmail_v1.Schema$Message>): gmail_v1.Schema$Message {
  return {
    id: 'msg_test_123',
    threadId: 'thread_test_1',
    labelIds: ['INBOX', 'IMPORTANT', 'UNREAD'],
    snippet: 'Revenue was $2.3M...',
    payload: {
      headers: [
        { name: 'Subject', value: 'Q4 Report Draft' },
        { name: 'From', value: 'Alice Smith <alice@company.com>' },
        { name: 'To', value: 'Bob Jones <bob@company.com>, Charlie <charlie@company.com>' },
        { name: 'Cc', value: 'Dave <dave@company.com>' },
        { name: 'Date', value: 'Thu, 20 Feb 2026 10:00:00 +0000' },
      ],
      mimeType: 'text/plain',
      body: {
        data: Buffer.from('Revenue was $2.3M for Q4. Full report attached.').toString('base64'),
      },
      parts: [
        {
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          body: { size: 1024 },
        },
      ],
    },
    ...overrides,
  };
}

describe('Gmail Connector', () => {
  it('maps raw Gmail API message to correct DataRow with all fields', () => {
    const msg = makeGmailMessage();
    const row = mapGmailMessage(msg);

    expect(row.source).toBe('gmail');
    expect(row.source_item_id).toBe('msg_test_123');
    expect(row.type).toBe('email');
    expect(row.timestamp).toBeTruthy();

    expect(row.data.title).toBe('Q4 Report Draft');
    expect(row.data.body).toContain('Revenue was $2.3M');
    expect(row.data.author_name).toBe('Alice Smith');
    expect(row.data.author_email).toBe('alice@company.com');
    expect(row.data.threadId).toBe('thread_test_1');
    expect(row.data.isUnread).toBe(true);
    expect(row.data.snippet).toBe('Revenue was $2.3M...');
    expect(row.data.url).toContain('msg_test_123');
  });

  it('extracts participants correctly', () => {
    const msg = makeGmailMessage();
    const row = mapGmailMessage(msg);
    const participants = row.data.participants as Array<{ name: string; email: string; role: string }>;

    expect(participants).toHaveLength(3);
    expect(participants[0]).toEqual({ name: 'Bob Jones', email: 'bob@company.com', role: 'to' });
    expect(participants[1]).toEqual({ name: 'Charlie', email: 'charlie@company.com', role: 'to' });
    expect(participants[2]).toEqual({ name: 'Dave', email: 'dave@company.com', role: 'cc' });
  });

  it('extracts labels correctly', () => {
    const msg = makeGmailMessage();
    const row = mapGmailMessage(msg);

    expect(row.data.labels).toEqual(['INBOX', 'IMPORTANT', 'UNREAD']);
  });

  it('extracts attachments metadata', () => {
    const msg = makeGmailMessage();
    const row = mapGmailMessage(msg);
    const attachments = row.data.attachments as Array<{ name: string; mimeType: string; sizeBytes: number }>;

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
  });

  it('handles message with no body gracefully', () => {
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: 'Subject', value: 'Empty email' },
          { name: 'From', value: 'test@test.com' },
          { name: 'Date', value: 'Thu, 20 Feb 2026 10:00:00 +0000' },
        ],
      },
    });

    const row = mapGmailMessage(msg);
    expect(row.data.title).toBe('Empty email');
    expect(row.data.body).toBe('');
  });

  it('handles HTML body by stripping tags', () => {
    const htmlBody = '<p>Hello <b>world</b></p><br><p>Second paragraph</p>';
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: 'Subject', value: 'HTML email' },
          { name: 'From', value: 'test@test.com' },
          { name: 'Date', value: 'Thu, 20 Feb 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/html',
        body: {
          data: Buffer.from(htmlBody).toString('base64'),
        },
      },
    });

    const row = mapGmailMessage(msg);
    expect(row.data.body).toContain('Hello');
    expect(row.data.body).toContain('world');
    expect(row.data.body).not.toContain('<p>');
    expect(row.data.body).not.toContain('<b>');
  });

  it('handles From header without angle brackets', () => {
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: 'Subject', value: 'Test' },
          { name: 'From', value: 'plainuser@example.com' },
          { name: 'Date', value: 'Thu, 20 Feb 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('test').toString('base64') },
      },
    });

    const row = mapGmailMessage(msg);
    expect(row.data.author_email).toBe('plainuser@example.com');
  });
});
