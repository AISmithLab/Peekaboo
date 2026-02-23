import { parseManifest } from '../manifest/parser.js';
import { validateManifest } from '../manifest/validator.js';
import type { Manifest } from '../manifest/types.js';

const KNOWN_OPERATOR_TYPES = new Set(['pull', 'select', 'filter', 'transform', 'stage', 'store']);

const SYSTEM_PROMPT = `You are a manifest DSL generator for a personal data access control system.

Given a natural language policy description about email access, output ONLY valid manifest DSL text. No explanations, no markdown fences, no commentary.

The DSL format:
@purpose: "short description of the policy"
@graph: op1 -> op2 -> op3
op1: operator_type { key: "value", key2: "value2" }

Available operator types and their properties:
- pull { source: "gmail", type: "email" } — always include this as the first operator
- filter { field: "...", op: "...", value: "..." } — filter rows. Fields: title, body, author_email, participants, labels, attachments, timestamp, snippet. Ops: eq, neq, contains, gt, lt.
- select { fields: ["field1", "field2"] } — choose which fields to include. All fields: ["title", "body", "author_email", "participants", "labels", "attachments", "timestamp", "snippet"]
- transform { kind: "redact", field: "...", pattern: "...", replacement: "..." } — redact sensitive data

Rules:
- For "hide body" or "hide attachments", use a select operator that lists only the fields to KEEP (omitting the hidden ones).
- For time-based filters, use filter with field "timestamp", op "gt", and value as ISO date string (YYYY-MM-DD).
- For sender filters, use filter with field "author_email", op "contains", and value as the email or domain.
- For subject keyword filters, use filter with field "title", op "contains".
- For exclusions (exclude newsletters, spam, etc.), use filter with field matching the content, op "neq".
- For attachment-only, use filter with field "attachments", op "gt", value: "0".
- Always start the graph with a pull operator.
- Output ONLY the DSL text, nothing else.`;

export interface TranslateSuccess {
  ok: true;
  result: {
    manifest: Manifest;
    rawManifest: string;
  };
}

export interface TranslateError {
  ok: false;
  error: 'NO_API_KEY' | 'API_ERROR' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'UNSUPPORTED_OPERATORS';
  message: string;
  unsupportedOperators?: string[];
}

export type TranslateResult = TranslateSuccess | TranslateError;

export async function translatePolicy(text: string, source: string): Promise<TranslateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY environment variable is not set' };
  }

  let rawManifest: string;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Convert this ${source} access policy to manifest DSL:\n\n${text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: 'API_ERROR', message: `Claude API returned ${response.status}: ${body}` };
    }

    const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
    rawManifest = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  } catch (err) {
    return { ok: false, error: 'API_ERROR', message: err instanceof Error ? err.message : 'Unknown fetch error' };
  }

  // Strip markdown fences if present
  rawManifest = rawManifest.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

  // Parse the manifest
  let manifest: Manifest;
  try {
    manifest = parseManifest(rawManifest, `policy-${source}`);
  } catch (err) {
    return { ok: false, error: 'PARSE_ERROR', message: err instanceof Error ? err.message : 'Failed to parse manifest' };
  }

  // Check for unsupported operator types
  const unsupported: string[] = [];
  for (const [, op] of manifest.operators) {
    if (!KNOWN_OPERATOR_TYPES.has(op.type)) {
      unsupported.push(op.type);
    }
  }
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: 'UNSUPPORTED_OPERATORS',
      message: `Unsupported operator types: ${unsupported.join(', ')}`,
      unsupportedOperators: unsupported,
    };
  }

  // Validate the manifest
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    return { ok: false, error: 'VALIDATION_ERROR', message: errors.map((e) => e.message).join('; ') };
  }

  return { ok: true, result: { manifest, rawManifest } };
}
