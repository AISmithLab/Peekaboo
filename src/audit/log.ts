import type Database from 'better-sqlite3';

export interface AuditEntry {
  id: number;
  timestamp: string;
  event: string;
  source: string | null;
  details: Record<string, unknown>;
}

export interface AuditFilters {
  after?: string;
  before?: string;
  event?: string;
  source?: string;
  limit?: number;
}

export class AuditLog {
  constructor(private db: Database.Database) {}

  insert(event: string, source: string | null, details: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (timestamp, event, source, details) VALUES (?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), event, source, JSON.stringify(details));
  }

  logPull(source: string, purpose: string, resultsReturned: number, initiatedBy: string): void {
    this.insert('data_pull', source, { purpose, resultsReturned, initiatedBy });
  }

  logCacheWrite(source: string, rowsWritten: number, initiatedBy: string): void {
    this.insert('cache_write', source, { rowsWritten, initiatedBy });
  }

  logActionProposed(
    actionId: string,
    source: string,
    actionType: string,
    purpose: string,
    initiatedBy: string,
  ): void {
    this.insert('action_proposed', source, { actionId, action_type: actionType, purpose, initiatedBy });
  }

  logActionApproved(actionId: string, initiatedBy: string, source?: string): void {
    this.insert('action_approved', source ?? null, { actionId, initiatedBy });
  }

  logActionRejected(actionId: string, initiatedBy: string, source?: string): void {
    this.insert('action_rejected', source ?? null, { actionId, initiatedBy });
  }

  logActionCommitted(actionId: string, source: string, result: string): void {
    this.insert('action_committed', source, { actionId, result });
  }

  getEntries(filters?: AuditFilters): AuditEntry[] {
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.after) {
      query += ' AND timestamp >= ?';
      params.push(filters.after);
    }

    if (filters?.before) {
      query += ' AND timestamp <= ?';
      params.push(filters.before);
    }

    if (filters?.event) {
      query += ' AND event = ?';
      params.push(filters.event);
    }

    if (filters?.source) {
      query += ' AND source = ?';
      params.push(filters.source);
    }

    query += ' ORDER BY id ASC';

    if (filters?.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      timestamp: string;
      event: string;
      source: string | null;
      details: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      event: row.event,
      source: row.source,
      details: JSON.parse(row.details),
    }));
  }
}
