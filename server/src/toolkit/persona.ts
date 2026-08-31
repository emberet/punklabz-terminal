import Anthropic from '@anthropic-ai/sdk';
import type { StrategyConfig } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { config } from '../config.js';

// User-defined agent personality. The user writes an intro and adds training
// notes over time; Claude distills them ONCE per update into bounded trait
// scores; deterministic code applies those scores to the strategy config at
// runtime. Same split as the manager: the LLM characterizes, the engine
// applies fixed, clamped numbers — a persona can tilt a bot, never unbound it.

const MODEL = 'claude-haiku-4-5-20251001';

export interface PersonaTraits {
  /** 0 = timid sizing, 1 = max-aggression sizing */
  aggression: number;
  /** 0 = trigger-happy, 1 = waits forever between trades */
  patience: number;
  /** 0 = cuts losses instantly, 1 = gives trades maximum room */
  riskTolerance: number;
}

export interface Persona {
  intro: string;
  notes: string[];
  traits: PersonaTraits;
  updatedAt: number;
}

export const NEUTRAL_TRAITS: PersonaTraits = { aggression: 0.5, patience: 0.5, riskTolerance: 0.5 };

const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0.5));

export function parsePersona(personaJson: string | null): Persona | null {
  if (!personaJson) return null;
  try {
    const p = JSON.parse(personaJson);
    return {
      intro: String(p.intro ?? ''),
      notes: Array.isArray(p.notes) ? p.notes.map(String).slice(0, 20) : [],
      traits: {
        aggression: clamp01(p.traits?.aggression),
        patience: clamp01(p.traits?.patience),
        riskTolerance: clamp01(p.traits?.riskTolerance),
      },
      updatedAt: Number(p.updatedAt ?? 0),
    };
  } catch {
    return null;
  }
}

/** Claude reads the intro + notes and scores the three traits (0..1). */
export async function distillTraits(intro: string, notes: string[]): Promise<PersonaTraits> {
  if (!config.anthropicApiKey) return { ...NEUTRAL_TRAITS };
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        'You translate a trading-bot personality description into three trait scores between 0 and 1. ' +
        'aggression: position sizing appetite (0 timid, 1 max). ' +
        'patience: willingness to wait between trades (0 trigger-happy, 1 very patient). ' +
        'riskTolerance: how much room losing trades get (0 cuts instantly, 1 maximum room). ' +
        'Call score_traits exactly once. Base scores ONLY on the text; default 0.5 when a trait is not implied.',
      tools: [{
        name: 'score_traits',
        description: 'Emit the trait scores.',
        input_schema: {
          type: 'object',
          properties: {
            aggression: { type: 'number', minimum: 0, maximum: 1 },
            patience: { type: 'number', minimum: 0, maximum: 1 },
            riskTolerance: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['aggression', 'patience', 'riskTolerance'],
        },
      }],
      tool_choice: { type: 'tool', name: 'score_traits' },
      messages: [{
        role: 'user',
        content: `Personality intro:\n${intro}\n\nTraining notes from the owner:\n${notes.map((n) => `- ${n}`).join('\n') || '(none)'}`,
      }],
    });
    const tool = res.content.find((b) => b.type === 'tool_use') as any;
    return {
      aggression: clamp01(tool?.input?.aggression),
      patience: clamp01(tool?.input?.patience),
      riskTolerance: clamp01(tool?.input?.riskTolerance),
    };
  } catch {
    return { ...NEUTRAL_TRAITS };
  }
}

export interface AppliedMod {
  field: string;
  base: number;
  applied: number;
}

/**
 * Deterministic, clamped application of traits to a DSL config.
 * Multipliers span ×0.6–×1.4 around neutral — a real tilt, never a bypass:
 * schema limits (positionSizePct ≤ 25, cooldown ≥ 1, stops 0.5–50) still hold.
 */
export function applyPersonaToConfig(
  cfg: StrategyConfig,
  traits: PersonaTraits,
): { config: StrategyConfig; mods: AppliedMod[] } {
  const mods: AppliedMod[] = [];
  const scaled = (base: number, trait: number, min: number, max: number, invert = false) => {
    const t = invert ? 1 - trait : trait;
    const applied = Math.min(max, Math.max(min, base * (0.6 + 0.8 * t)));
    return Math.round(applied * 100) / 100;
  };

  const out: StrategyConfig = JSON.parse(JSON.stringify(cfg));

  const size = scaled(cfg.capital.positionSizePct, traits.aggression, 1, 25);
  mods.push({ field: 'positionSizePct', base: cfg.capital.positionSizePct, applied: size });
  out.capital.positionSizePct = size;

  const cooldown = scaled(cfg.risk.cooldownMinutes, traits.patience, 1, 1440);
  mods.push({ field: 'cooldownMinutes', base: cfg.risk.cooldownMinutes, applied: cooldown });
  out.risk.cooldownMinutes = cooldown;

  const trades = Math.round(scaled(cfg.risk.maxTradesPerDay, traits.patience, 1, 100, true));
  mods.push({ field: 'maxTradesPerDay', base: cfg.risk.maxTradesPerDay, applied: trades });
  out.risk.maxTradesPerDay = trades;

  const stop = scaled(cfg.risk.stopLossPct, traits.riskTolerance, 0.5, 50);
  mods.push({ field: 'stopLossPct', base: cfg.risk.stopLossPct, applied: stop });
  out.risk.stopLossPct = stop;

  return { config: out, mods };
}

export function savePersona(db: DB, botId: number, persona: Persona): void {
  db.prepare(`UPDATE bots SET persona_json = ? WHERE id = ?`).run(JSON.stringify(persona), botId);
}
