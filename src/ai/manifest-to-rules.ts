import type { Manifest } from '../manifest/types.js';

export interface UIRule {
  type: 'time' | 'from' | 'subject' | 'exclude' | 'attachment' | 'hideField';
  enabled: boolean;
  value?: string;
}

const FIELD_DISPLAY_NAMES: Record<string, string> = {
  title: 'Subject',
  body: 'Body',
  author_email: 'Sender',
  participants: 'Recipients',
  labels: 'Labels',
  attachments: 'Attachments',
  snippet: 'Snippet',
};

const ALL_FIELDS = ['title', 'body', 'author_email', 'participants', 'labels', 'attachments', 'timestamp', 'snippet'];

export function manifestToRules(manifest: Manifest): UIRule[] {
  const rules: UIRule[] = [];

  for (const [, op] of manifest.operators) {
    if (op.type === 'filter') {
      const field = op.properties.field as string | undefined;
      const filterOp = op.properties.op as string | undefined;
      const value = op.properties.value as string | undefined;

      if (field === 'timestamp' && filterOp === 'gt' && value) {
        rules.push({ type: 'time', enabled: true, value });
      } else if (field === 'author_email' && filterOp === 'contains' && value) {
        rules.push({ type: 'from', enabled: true, value });
      } else if (field === 'title' && filterOp === 'contains' && value) {
        rules.push({ type: 'subject', enabled: true, value });
      } else if (filterOp === 'neq' && value) {
        rules.push({ type: 'exclude', enabled: true, value });
      } else if (field === 'attachments' && filterOp === 'gt') {
        rules.push({ type: 'attachment', enabled: true });
      }
    } else if (op.type === 'select') {
      const fields = op.properties.fields as string[] | undefined;
      if (Array.isArray(fields)) {
        // Fields NOT in the select list should become hideField rules
        for (const f of ALL_FIELDS) {
          if (!fields.includes(f) && FIELD_DISPLAY_NAMES[f]) {
            rules.push({ type: 'hideField', enabled: true, value: FIELD_DISPLAY_NAMES[f] });
          }
        }
      }
    } else if (op.type === 'transform') {
      const kind = op.properties.kind as string | undefined;
      const field = op.properties.field as string | undefined;
      if (kind === 'redact' && field && FIELD_DISPLAY_NAMES[field]) {
        rules.push({ type: 'hideField', enabled: true, value: FIELD_DISPLAY_NAMES[field] });
      }
    }
  }

  return rules;
}
