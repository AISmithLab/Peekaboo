import type { DataStore } from '../../database/datastore.js';

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
  constructor(private store: DataStore) {}

  async insert(event: string, source: string | null, details: Record<string, unknown>): Promise<void> {
    await this.store.insertAuditEntry({
      timestamp: new Date().toISOString(),
      event,
      source,
      details: JSON.stringify(details),
    });
  }

  async logPull(source: string, purpose: string, resultsReturned: number, initiatedBy: string): Promise<void> {
    await this.insert('data_pull', source, { purpose, resultsReturned, initiatedBy });
  }

  async logActionProposed(
    actionId: string,
    source: string,
    actionType: string,
    purpose: string,
    initiatedBy: string,
  ): Promise<void> {
    await this.insert('action_proposed', source, { actionId, action_type: actionType, purpose, initiatedBy });
  }

  async logActionApproved(actionId: string, initiatedBy: string, source?: string): Promise<void> {
    await this.insert('action_approved', source ?? null, { actionId, initiatedBy });
  }

  async logActionRejected(actionId: string, initiatedBy: string, source?: string): Promise<void> {
    await this.insert('action_rejected', source ?? null, { actionId, initiatedBy });
  }

  async logActionCommitted(actionId: string, source: string, result: string): Promise<void> {
    await this.insert('action_committed', source, { actionId, result });
  }

  async getEntries(filters?: AuditFilters): Promise<AuditEntry[]> {
    const rows = await this.store.queryAuditEntries({
      after: filters?.after,
      before: filters?.before,
      event: filters?.event,
      source: filters?.source,
      limit: filters?.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      event: row.event,
      source: row.source,
      details: JSON.parse(row.details),
    }));
  }
}
