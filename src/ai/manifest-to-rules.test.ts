import { describe, it, expect } from 'vitest';
import { manifestToRules } from './manifest-to-rules.js';
import { parseManifest } from '../manifest/parser.js';

function makeManifest(dsl: string) {
  return parseManifest(dsl, 'test');
}

describe('manifestToRules', () => {
  it('converts filter timestamp → time rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> f
pull: pull { source: "gmail", type: "email" }
f: filter { field: "timestamp", op: "gt", value: "2025-01-15" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'time', enabled: true, value: '2025-01-15' });
  });

  it('converts filter author_email → from rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> f
pull: pull { source: "gmail", type: "email" }
f: filter { field: "author_email", op: "contains", value: "@company.com" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'from', enabled: true, value: '@company.com' });
  });

  it('converts filter title contains → subject rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> f
pull: pull { source: "gmail", type: "email" }
f: filter { field: "title", op: "contains", value: "meeting" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'subject', enabled: true, value: 'meeting' });
  });

  it('converts filter neq → exclude rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> f
pull: pull { source: "gmail", type: "email" }
f: filter { field: "labels", op: "neq", value: "spam" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'exclude', enabled: true, value: 'spam' });
  });

  it('converts filter attachments gt → attachment rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> f
pull: pull { source: "gmail", type: "email" }
f: filter { field: "attachments", op: "gt", value: "0" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'attachment', enabled: true });
  });

  it('converts select with subset of fields → hideField rules for missing fields', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> s
pull: pull { source: "gmail", type: "email" }
s: select { fields: ["title", "author_email", "timestamp"] }
`);
    const rules = manifestToRules(m);
    // body, participants, labels, attachments, snippet should be hidden
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Body' });
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Recipients' });
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Labels' });
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Attachments' });
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Snippet' });
    // Subject and Sender should NOT be hidden
    expect(rules).not.toContainEqual(expect.objectContaining({ value: 'Subject' }));
    expect(rules).not.toContainEqual(expect.objectContaining({ value: 'Sender' }));
  });

  it('converts transform redact → hideField rule', () => {
    const m = makeManifest(`
@purpose: "Test"
@graph: pull -> t
pull: pull { source: "gmail", type: "email" }
t: transform { kind: "redact", field: "body", pattern: ".*", replacement: "[REDACTED]" }
`);
    const rules = manifestToRules(m);
    expect(rules).toContainEqual({ type: 'hideField', enabled: true, value: 'Body' });
  });

  it('handles multiple operators producing multiple rules', () => {
    const m = makeManifest(`
@purpose: "Complex policy"
@graph: pull -> f1 -> f2 -> sel
pull: pull { source: "gmail", type: "email" }
f1: filter { field: "timestamp", op: "gt", value: "2025-01-01" }
f2: filter { field: "author_email", op: "contains", value: "@example.com" }
sel: select { fields: ["title", "author_email", "timestamp", "snippet"] }
`);
    const rules = manifestToRules(m);
    expect(rules.length).toBeGreaterThanOrEqual(4); // time + from + hideField(Body, Recipients, Labels, Attachments)
    expect(rules).toContainEqual({ type: 'time', enabled: true, value: '2025-01-01' });
    expect(rules).toContainEqual({ type: 'from', enabled: true, value: '@example.com' });
  });
});
