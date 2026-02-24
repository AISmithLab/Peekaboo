import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { encryptField } from '../db/encryption.js';

interface SyncDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  encryptionKey?: string;
}

/**
 * Parse an interval string like "10m", "1h", "30s" into milliseconds.
 */
export function parseInterval(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid interval format: "${str}". Expected e.g. "10m", "1h", "30s".`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: throw new Error(`Unknown interval unit: "${unit}"`);
  }
}

/**
 * Sync a single source: fetch live data from connector and store to cached_data.
 * No filters applied during sync — we cache everything, filter at read time.
 */
export async function syncSource(deps: SyncDeps, source: string): Promise<void> {
  const connector = deps.connectorRegistry.get(source);
  if (!connector) {
    console.log(`[sync] No connector for source "${source}", skipping`);
    return;
  }

  const sourceConfig = deps.config.sources[source];
  const boundary = sourceConfig?.boundary ?? {};

  const rows = await connector.fetch(boundary);

  // Store to cached_data (upsert)
  const upsert = deps.db.prepare(`
    INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data, cached_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(source, source_item_id) DO UPDATE SET
      type = excluded.type,
      timestamp = excluded.timestamp,
      data = excluded.data,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `);

  const ttl = sourceConfig?.cache?.ttl;
  const expiresAt = ttl ? computeExpiresAt(ttl) : null;

  const insertMany = deps.db.transaction(() => {
    for (const row of rows) {
      let dataStr = JSON.stringify(row.data);
      if (deps.encryptionKey) {
        dataStr = encryptField(dataStr, deps.encryptionKey);
      }
      upsert.run(
        randomUUID(),
        row.source,
        row.source_item_id,
        row.type,
        row.timestamp,
        dataStr,
        expiresAt,
      );
    }
  });

  insertMany();
  console.log(`[sync] ${source}: fetched and stored ${rows.length} items`);
}

/**
 * Start background sync jobs for all cache-enabled sources.
 * For sources with cache disabled, deletes any stale cached data.
 * Returns a cleanup function that clears all intervals.
 */
export function startSyncJobs(deps: SyncDeps): () => void {
  const timers: NodeJS.Timeout[] = [];

  for (const [source, sourceConfig] of Object.entries(deps.config.sources)) {
    if (!sourceConfig.cache?.enabled) {
      // Cache disabled — purge any leftover cached data for this source
      const deleted = deps.db.prepare('DELETE FROM cached_data WHERE source = ?').run(source);
      if (deleted.changes > 0) {
        console.log(`[sync] Cache disabled for "${source}", deleted ${deleted.changes} cached rows`);
      }
      continue;
    }

    const intervalStr = sourceConfig.cache.sync_interval ?? '10m';
    const intervalMs = parseInterval(intervalStr);

    console.log(`[sync] Scheduling sync for "${source}" every ${intervalStr}`);

    // Run initial sync immediately
    syncSource(deps, source).catch((err) => {
      console.error(`[sync] Initial sync failed for "${source}":`, err);
    });

    // Schedule recurring sync
    const timer = setInterval(() => {
      syncSource(deps, source).catch((err) => {
        console.error(`[sync] Sync failed for "${source}":`, err);
      });
    }, intervalMs);

    timer.unref();
    timers.push(timer);
  }

  return () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
  };
}

function computeExpiresAt(ttl: string): string {
  const now = Date.now();
  const match = ttl.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  let ms: number;
  switch (unit) {
    case 'd': ms = amount * 24 * 60 * 60 * 1000; break;
    case 'h': ms = amount * 60 * 60 * 1000; break;
    case 'm': ms = amount * 60 * 1000; break;
    default: ms = 7 * 24 * 60 * 60 * 1000;
  }

  return new Date(now + ms).toISOString();
}
