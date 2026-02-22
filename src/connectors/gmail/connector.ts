import { google, type gmail_v1 } from 'googleapis';
import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export interface GmailConnectorConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
}

export class GmailConnector implements SourceConnector {
  name = 'gmail';
  private gmail: gmail_v1.Gmail;
  private auth: InstanceType<typeof google.auth.OAuth2>;
  private lastSyncTimestamp?: string;

  constructor(config: GmailConnectorConfig) {
    this.auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    if (config.accessToken || config.refreshToken) {
      this.auth.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
      });
    }
    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
  }

  /**
   * Expose the underlying OAuth2 client so callers can listen for
   * the 'tokens' event (fired when tokens are auto-refreshed).
   */
  getAuth(): InstanceType<typeof google.auth.OAuth2> {
    return this.auth;
  }

  async fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]> {
    const query = buildGmailQuery(boundary, params);
    const maxResults = (params?.limit as number) ?? 50;

    const listResponse = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listResponse.data.messages ?? [];
    const rows: DataRow[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;

      const fullMsg = await this.gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      rows.push(mapGmailMessage(fullMsg.data));
    }

    return rows;
  }

  async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
    switch (actionType) {
      case 'send_email':
        return this.sendEmail(actionData);
      case 'reply_email':
        return this.replyEmail(actionData);
      case 'draft_email':
        return this.draftEmail(actionData);
      default:
        return { success: false, message: `Unknown action type: ${actionType}` };
    }
  }

  async sync(boundary: SourceBoundary): Promise<DataRow[]> {
    const params: Record<string, unknown> = {};
    if (this.lastSyncTimestamp) {
      params.query = `after:${this.lastSyncTimestamp.split('T')[0].replace(/-/g, '/')}`;
    }

    const rows = await this.fetch(boundary, params);
    this.lastSyncTimestamp = new Date().toISOString();
    return rows;
  }

  private async sendEmail(data: Record<string, unknown>): Promise<ActionResult> {
    const raw = createMimeMessage(
      data.to as string,
      data.subject as string,
      data.body as string,
    );

    await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return { success: true, message: 'Email sent' };
  }

  private async replyEmail(data: Record<string, unknown>): Promise<ActionResult> {
    const raw = createMimeMessage(
      data.to as string,
      data.subject as string,
      data.body as string,
    );

    await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: data.in_reply_to as string,
      },
    });

    return { success: true, message: 'Reply sent' };
  }

  private async draftEmail(data: Record<string, unknown>): Promise<ActionResult> {
    const raw = createMimeMessage(
      data.to as string,
      data.subject as string,
      data.body as string,
    );

    const draft = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });

    return {
      success: true,
      message: 'Draft created',
      resultData: { draftId: draft.data.id },
    };
  }
}

function buildGmailQuery(boundary: SourceBoundary, params?: Record<string, unknown>): string {
  const parts: string[] = [];

  if (boundary.after) {
    const date = boundary.after.split('T')[0].replace(/-/g, '/');
    parts.push(`after:${date}`);
  }

  if (boundary.labels) {
    for (const label of boundary.labels) {
      parts.push(`label:${label}`);
    }
  }

  if (boundary.exclude_labels) {
    for (const label of boundary.exclude_labels) {
      parts.push(`-label:${label}`);
    }
  }

  if (params?.query) {
    parts.push(params.query as string);
  }

  return parts.join(' ');
}

export function mapGmailMessage(msg: gmail_v1.Schema$Message): DataRow {
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const subject = getHeader('Subject');
  const from = getHeader('From');
  const to = getHeader('To');
  const cc = getHeader('Cc');
  const date = getHeader('Date');

  // Parse "Name <email>" format
  const fromMatch = from.match(/^(.+?)\s*<(.+?)>$/);
  const authorName = fromMatch ? fromMatch[1].trim().replace(/^"|"$/g, '') : from;
  const authorEmail = fromMatch ? fromMatch[2] : from;

  // Extract body
  const body = extractTextBody(msg.payload);

  // Parse participants
  const participants = parseParticipants(to, cc);

  // Labels
  const labels = msg.labelIds ?? [];

  // Attachments
  const attachments = extractAttachments(msg.payload);

  return {
    source: 'gmail',
    source_item_id: msg.id ?? '',
    type: 'email',
    timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
    data: {
      title: subject,
      body,
      author_name: authorName,
      author_email: authorEmail,
      participants,
      labels,
      url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
      attachments,
      threadId: msg.threadId ?? '',
      isUnread: labels.includes('UNREAD'),
      snippet: msg.snippet ?? '',
    },
  };
}

function extractTextBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  // Multipart — look for text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractTextBody(part);
      if (text) return text;
    }
  }

  // Fallback: HTML body
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf8');
    return stripHtml(html);
  }

  return '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function parseParticipants(to: string, cc: string): Array<{ name: string; email: string; role: string }> {
  const participants: Array<{ name: string; email: string; role: string }> = [];

  for (const addr of splitAddresses(to)) {
    const parsed = parseAddress(addr);
    if (parsed) participants.push({ ...parsed, role: 'to' });
  }

  for (const addr of splitAddresses(cc)) {
    const parsed = parseAddress(addr);
    if (parsed) participants.push({ ...parsed, role: 'cc' });
  }

  return participants;
}

function splitAddresses(header: string): string[] {
  if (!header) return [];
  return header.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseAddress(addr: string): { name: string; email: string } | null {
  const match = addr.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2] };
  }
  if (addr.includes('@')) {
    return { name: addr, email: addr };
  }
  return null;
}

function extractAttachments(payload?: gmail_v1.Schema$MessagePart): Array<{ name: string; mimeType: string; sizeBytes: number }> {
  const attachments: Array<{ name: string; mimeType: string; sizeBytes: number }> = [];

  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.filename.length > 0) {
      attachments.push({
        name: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
      });
    }
  }

  return attachments;
}

function createMimeMessage(to: string, subject: string, body: string): string {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(message).toString('base64url');
}
