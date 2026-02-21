import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { hubConfigSchema, type HubConfigParsed } from './schema.js';

/**
 * Resolve ${ENV_VAR} placeholders in a string from process.env.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envVar: string) => {
    const resolved = process.env[envVar];
    if (resolved === undefined) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return resolved;
  });
}

/**
 * Recursively resolve env var placeholders in an object.
 */
function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVarsDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load and validate a hub-config.yaml file.
 */
export function loadConfig(configPath: string): HubConfigParsed {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  const resolved = resolveEnvVarsDeep(parsed);
  return hubConfigSchema.parse(resolved);
}
