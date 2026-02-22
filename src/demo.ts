import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEMO_EMAILS } from './fixtures/emails.js';

const DEMO_MANIFESTS = [
  {
    id: 'demo-gmail-readonly',
    source: 'gmail',
    purpose: 'Pull emails with common fields (title, body, labels, author_name)',
    raw_text: [
      '@purpose: "Pull emails with common fields (title, body, labels, author_name)"',
      '@graph: pull_emails -> select_fields',
      'pull_emails: pull { source: "gmail", type: "email" }',
      'select_fields: select { fields: ["title", "body", "labels", "author_name"] }',
    ].join('\n'),
  },
  {
    id: 'demo-gmail-metadata',
    source: 'gmail',
    purpose: 'Pull email metadata only (title, labels, author_name)',
    raw_text: [
      '@purpose: "Pull email metadata only (title, labels, author_name)"',
      '@graph: pull_emails -> select_fields',
      'pull_emails: pull { source: "gmail", type: "email" }',
      'select_fields: select { fields: ["title", "labels", "author_name"] }',
    ].join('\n'),
  },
  {
    id: 'demo-gmail-redacted',
    source: 'gmail',
    purpose: 'Pull emails with SSN redaction',
    raw_text: [
      '@purpose: "Pull emails with SSN redaction"',
      '@graph: pull_emails -> select_fields -> redact_ssn',
      'pull_emails: pull { source: "gmail", type: "email" }',
      'select_fields: select { fields: ["title", "body", "labels", "author_name"] }',
      'redact_ssn: transform { kind: "redact", field: "body", pattern: "\\d{3}-\\d{2}-\\d{4}", replacement: "[SSN REDACTED]" }',
    ].join('\n'),
  },
];

export function loadDemoData(db: Database.Database): { emailCount: number; manifestCount: number } {
  const upsertEmail = db.prepare(`
    INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, source_item_id) DO UPDATE SET
      type = excluded.type,
      timestamp = excluded.timestamp,
      data = excluded.data,
      cached_at = datetime('now')
  `);

  const upsertManifest = db.prepare(`
    INSERT INTO manifests (id, source, purpose, raw_text, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT (id) DO UPDATE SET
      source = excluded.source,
      purpose = excluded.purpose,
      raw_text = excluded.raw_text,
      status = 'active',
      updated_at = datetime('now')
  `);

  const insertAll = db.transaction(() => {
    for (const email of DEMO_EMAILS) {
      upsertEmail.run(
        `demo_${randomUUID()}`,
        email.source,
        email.source_item_id,
        email.type,
        email.timestamp,
        JSON.stringify(email.data),
      );
    }
    for (const m of DEMO_MANIFESTS) {
      upsertManifest.run(m.id, m.source, m.purpose, m.raw_text);
    }
  });

  insertAll();

  return {
    emailCount: DEMO_EMAILS.length,
    manifestCount: DEMO_MANIFESTS.length,
  };
}

export function unloadDemoData(db: Database.Database): { emailsRemoved: number; manifestsRemoved: number } {
  const delEmails = db.prepare("DELETE FROM cached_data WHERE source_item_id LIKE 'demo_%'");
  const delManifests = db.prepare("DELETE FROM manifests WHERE id LIKE 'demo-%'");

  const result = db.transaction(() => {
    const emailResult = delEmails.run();
    const manifestResult = delManifests.run();
    return {
      emailsRemoved: emailResult.changes,
      manifestsRemoved: manifestResult.changes,
    };
  });

  return result();
}
