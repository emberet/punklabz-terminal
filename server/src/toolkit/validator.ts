import { lintStrategyConfig, strategyConfigSchema, type StrategyConfig } from '@punklabz/shared';

export interface ValidationResult {
  ok: boolean;
  config?: StrategyConfig;
  errors: string[];
}

/**
 * Small models sometimes emit nested tool-input objects as JSON *strings*
 * ("market": "{\"venue\":...}") and numeric literals as strings. Revive those
 * before validation; anything that still doesn't parse is left as-is for zod
 * to reject.
 */
function reviveStringifiedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return reviveStringifiedJson(JSON.parse(t));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(reviveStringifiedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, reviveStringifiedJson(v)]),
    );
  }
  return value;
}

/** zod parse + semantic lint. The only gate between Claude's output and the engine. */
export function validateStrategyConfig(raw: unknown): ValidationResult {
  const revived = reviveStringifiedJson(raw);
  if (revived && typeof revived === 'object' && typeof (revived as any).version === 'string') {
    const n = Number((revived as any).version);
    if (Number.isInteger(n)) (revived as any).version = n;
  }
  const parsed = strategyConfigSchema.safeParse(revived);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const lintErrors = lintStrategyConfig(parsed.data);
  if (lintErrors.length > 0) return { ok: false, errors: lintErrors };
  return { ok: true, config: parsed.data, errors: [] };
}
