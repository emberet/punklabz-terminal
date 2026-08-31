import { lintStrategyConfig, strategyConfigSchema, type StrategyConfig } from '@punklabz/shared';

export interface ValidationResult {
  ok: boolean;
  config?: StrategyConfig;
  errors: string[];
}

/** zod parse + semantic lint. The only gate between Claude's output and the engine. */
export function validateStrategyConfig(raw: unknown): ValidationResult {
  const parsed = strategyConfigSchema.safeParse(raw);
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
