import type { DataRow } from './connectors/types.js';

export interface QuickFilter {
  id: string;
  source: string;
  type: string;
  value: string;
  enabled: number;
}

export interface FilterTypeMeta {
  label: string;
  placeholder: string;
  needsValue: boolean;
}

export const FILTER_TYPES: Record<string, FilterTypeMeta> = {
  time_after: { label: 'Only emails after', placeholder: 'YYYY-MM-DD', needsValue: true },
  from_include: { label: 'Only from sender', placeholder: 'e.g. alice@co.com', needsValue: true },
  subject_include: { label: 'Subject contains', placeholder: 'e.g. meeting', needsValue: true },
  exclude_sender: { label: 'Exclude sender', placeholder: 'e.g. noreply@', needsValue: true },
  exclude_keyword: { label: 'Exclude subject containing', placeholder: 'e.g. newsletter', needsValue: true },
  has_attachment: { label: 'Only with attachments', placeholder: '', needsValue: false },
  hide_field: { label: 'Hide field from agents', placeholder: 'e.g. body', needsValue: true },
};

/**
 * Apply enabled quick filters to a set of data rows.
 * Each filter is either a predicate (keeps/drops rows) or a field-remover.
 */
export function applyFilters(rows: DataRow[], filters: QuickFilter[]): DataRow[] {
  const enabledFilters = filters.filter((f) => f.enabled);
  if (!enabledFilters.length) return rows;

  // Separate field-hiding filters from row filters
  const hideFields: string[] = [];
  const rowFilters: QuickFilter[] = [];

  for (const f of enabledFilters) {
    if (f.type === 'hide_field') {
      hideFields.push(f.value.toLowerCase());
    } else {
      rowFilters.push(f);
    }
  }

  // Apply row predicates
  let result = rows;
  for (const f of rowFilters) {
    result = result.filter((row) => matchesFilter(row, f));
  }

  // Apply field hiding
  if (hideFields.length) {
    result = result.map((row) => ({
      ...row,
      data: Object.fromEntries(
        Object.entries(row.data).filter(
          ([key]) => !hideFields.includes(key.toLowerCase()),
        ),
      ),
    }));
  }

  return result;
}

function matchesFilter(row: DataRow, filter: QuickFilter): boolean {
  const d = row.data;
  const val = filter.value;

  switch (filter.type) {
    case 'time_after':
      return new Date(row.timestamp) >= new Date(val);

    case 'from_include': {
      const sender = String(d.author_email || d.author_name || '').toLowerCase();
      return sender.includes(val.toLowerCase());
    }

    case 'subject_include': {
      const title = String(d.title || '').toLowerCase();
      return title.includes(val.toLowerCase());
    }

    case 'exclude_sender': {
      const sender = String(d.author_email || d.author_name || '').toLowerCase();
      return !sender.includes(val.toLowerCase());
    }

    case 'exclude_keyword': {
      const title = String(d.title || '').toLowerCase();
      return !title.includes(val.toLowerCase());
    }

    case 'has_attachment': {
      const attachments = d.attachments as unknown[] | undefined;
      return Array.isArray(attachments) && attachments.length > 0;
    }

    default:
      return true;
  }
}
