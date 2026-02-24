import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { parseManifest } from '../manifest/parser.js';
import { executePipeline } from '../pipeline/engine.js';
import { createPipelineContext } from '../pipeline/context.js';

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
 * Sync a single source: find its active manifest, auto-append a store node
 * if needed, and run the pipeline with cacheOnly: false to fetch live data
 * and persist it to cache.
 */
export async function syncSource(deps: SyncDeps, source: string): Promise<void> {
  // Find the active manifest for this source
  const row = deps.db.prepare(
    "SELECT id, raw_text FROM manifests WHERE source = ? AND status = 'active' LIMIT 1",
  ).get(source) as { id: string; raw_text: string } | undefined;

  if (!row) {
    console.log(`[sync] No active manifest for source "${source}", skipping`);
    return;
  }

  const parsed = parseManifest(row.raw_text, row.id);

  // Auto-append a store node if the manifest doesn't already have one
  const hasStore = Array.from(parsed.operators.values()).some((op) => op.type === 'store');
  if (!hasStore) {
    parsed.operators.set('_auto_store', {
      name: '_auto_store',
      type: 'store',
      properties: {},
    });
    parsed.graph.push('_auto_store');
  }

  const ctx = createPipelineContext({
    db: deps.db,
    connectorRegistry: deps.connectorRegistry,
    config: deps.config,
    appId: 'sync',
    manifestId: row.id,
    encryptionKey: deps.encryptionKey,
    cacheOnly: false,
  });

  const result = await executePipeline(parsed, ctx);
  console.log(`[sync] ${source}: fetched ${result.meta.itemsFetched} items, stored ${result.meta.itemsReturned}`);
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
