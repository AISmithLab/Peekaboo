import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEMO_EMAILS } from './fixtures/emails.js';

export function loadDemoData(db: Database.Database): { emailCount: number } {
  const upsertEmail = db.prepare(`
    INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, source_item_id) DO UPDATE SET
      type = excluded.type,
      timestamp = excluded.timestamp,
      data = excluded.data,
      cached_at = datetime('now')
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
  });

  insertAll();

  return {
    emailCount: DEMO_EMAILS.length,
  };
}

export function unloadDemoData(db: Database.Database): { emailsRemoved: number } {
  const delEmails = db.prepare("DELETE FROM cached_data WHERE source_item_id LIKE 'demo_%'");

  const result = db.transaction(() => {
    const emailResult = delEmails.run();
    return {
      emailsRemoved: emailResult.changes,
    };
  });

  return result();
}
