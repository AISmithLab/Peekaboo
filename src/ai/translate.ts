import { parseManifest } from '../manifest/parser.js';
import { validateManifest } from '../manifest/validator.js';
import type { Manifest } from '../manifest/types.js';
import { KNOWN_OPERATOR_TYPES } from '../operators/registry.js';

const SYSTEM_PROMPT = `You are a manifest DSL generator for a personal data access control system.

Given a natural language policy description about email access, output ONLY valid manifest DSL text. No explanations, no markdown fences, no commentary.

The DSL format:
@purpose: "short description of the policy"
@graph: op1 -> op2 -> op3
op1: operator_type { key: "value", key2: "value2" }

Available operator types and their properties:
- pull { source: "gmail", type: "email" } — always include this as the first operator
- filter { field: "...", op: "...", value: "..." } — filter rows. Fields: title, body, author_email, participants, labels, attachments, timestamp, snippet. Ops: eq, contains, gt, lt.
- select { fields: ["field1", "field2"] } — choose which fields to include. All fields: ["title", "body", "author_email", "participants", "labels", "attachments", "timestamp", "snippet"]
- transform { kind: "redact", field: "...", pattern: "...", replacement: "..." } — redact sensitive data

Rules:
- For "hide body" or "hide attachments", use a select operator that lists only the fields to KEEP (omitting the hidden ones).
- For time-based filters, use filter with field "timestamp", op "gt", and value as ISO date string (YYYY-MM-DD).
- For sender filters, use filter with field "author_email", op "contains", and value as the email or domain.
- For subject keyword filters, use filter with field "title", op "contains".
- For attachment-only, use filter with field "attachments", op "gt", value: "0".
- Always start the graph with a pull operator.
- Output ONLY the DSL text, nothing else.`;

const EXPLANATION_PROMPT = `You are given a data access control manifest in DSL format.
Explain in 1-3 plain English sentences what this manifest does.
Focus on what data is accessible and what restrictions apply.
Output ONLY the explanation text, nothing else.`;

export interface TranslateSuccess {
  ok: true;
  result: {
    manifest: Manifest;
    rawManifest: string;
    explanation: string;
  };
}

export interface TranslateError {
  ok: false;
  error: 'NO_API_KEY' | 'API_ERROR' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'UNSUPPORTED_OPERATORS';
  message: string;
  unsupportedOperators?: string[];
}

export type TranslateResult = TranslateSuccess | TranslateError;

interface ProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
}

function detectProvider(): ProviderConfig | null {
  const model = process.env.AI_MODEL;
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: model || 'claude-sonnet-4-20250514' };
  }
  if (process.env.GOOGLE_AI_API_KEY) {
    return { provider: 'google', apiKey: process.env.GOOGLE_AI_API_KEY, model: model || 'gemini-2.0-flash' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: model || 'gpt-4o' };
  }
  return null;
}

async function callProvider(config: ProviderConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  if (config.provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.model, max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    });
    if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
    const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
    return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  } else if (config.provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: userPrompt }] }] }),
    });
    if (!response.ok) throw new Error(`Google AI API returned ${response.status}`);
    const data = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates[0]?.content?.parts?.map((p) => p.text).join('\n') ?? '';
  } else if (config.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, max_tokens: 256, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
    });
    if (!response.ok) throw new Error(`OpenAI API returned ${response.status}`);
    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

async function generateExplanation(config: ProviderConfig, rawManifest: string): Promise<string> {
  return callProvider(config, EXPLANATION_PROMPT, `Explain this manifest:\n\n${rawManifest}`);
}

export async function translatePolicy(text: string, source: string): Promise<TranslateResult> {
  const config = detectProvider();
  if (!config) {
    return { ok: false, error: 'NO_API_KEY', message: 'No AI provider API key configured' };
  }

  const userPrompt = `Convert this ${source} access policy to manifest DSL:\n\n${text}`;

  let rawManifest: string;
  try {
    rawManifest = await callProvider(config, SYSTEM_PROMPT, userPrompt);
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

  // Generate plain English explanation (non-fatal if it fails)
  let explanation = manifest.purpose;
  try {
    explanation = await generateExplanation(config, rawManifest);
  } catch (_) { /* use purpose as fallback */ }

  return { ok: true, result: { manifest, rawManifest, explanation } };
}
