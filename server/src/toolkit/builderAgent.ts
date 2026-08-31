import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { strategyConfigSchema } from '@punklabz/shared';
import { config } from '../config.js';
import { validateStrategyConfig } from './validator.js';

const MODEL = 'claude-haiku-4-5-20251001';

export interface BuilderTurn {
  assistantText: string;
  draftConfig: unknown | null;
  valid: boolean;
  errors: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const FEW_SHOT = `
Example configs:

"buy the dip on BTC when RSI is oversold, take profit at 5%":
{"version":1,"name":"btc dip buyer","market":{"venue":"binance","symbols":["BTCUSDT"],"interval":"5m"},"capital":{"initialBalanceUsd":10000,"positionSizePct":10,"maxOpenPositions":1},"entry":{"all":[{"kind":"indicator","indicator":"rsi","period":14,"op":"lt","value":30}]},"exit":{"any":[{"kind":"indicator","indicator":"rsi","period":14,"op":"gt","value":55}]},"risk":{"stopLossPct":3,"takeProfitPct":5,"cooldownMinutes":15,"maxTradesPerDay":10}}

"ride SOL breakouts when price crosses above the 50 EMA with strong volume":
{"version":1,"name":"sol breakout rider","market":{"venue":"binance","symbols":["SOLUSDT"],"interval":"15m"},"capital":{"initialBalanceUsd":10000,"positionSizePct":15,"maxOpenPositions":1},"entry":{"all":[{"kind":"indicator","indicator":"price","op":"crossAbove","valueRef":{"indicator":"ema","period":50}},{"kind":"indicator","indicator":"volume","op":"gt","valueRef":{"indicator":"volumeSma","period":20}}]},"exit":{"any":[{"kind":"indicator","indicator":"price","op":"crossBelow","valueRef":{"indicator":"ema","period":50}},{"kind":"risk","type":"takeProfitPct","value":8}]},"risk":{"stopLossPct":4,"takeProfitPct":8,"cooldownMinutes":30,"maxTradesPerDay":8}}

"scalp ETH volatility both ways with bollinger bands":
{"version":1,"name":"eth bb scalper","market":{"venue":"binance","symbols":["ETHUSDT"],"interval":"5m"},"capital":{"initialBalanceUsd":10000,"positionSizePct":12,"maxOpenPositions":1},"entry":{"all":[{"kind":"indicator","indicator":"price","op":"lt","valueRef":{"indicator":"bollingerLower","period":20}}]},"exit":{"any":[{"kind":"indicator","indicator":"price","op":"gte","valueRef":{"indicator":"sma","period":20}},{"kind":"risk","type":"takeProfitPct","value":4}]},"risk":{"stopLossPct":2.5,"takeProfitPct":4,"cooldownMinutes":10,"maxTradesPerDay":20}}
`;

function systemPrompt(): string {
  const jsonSchema = JSON.stringify(zodToJsonSchema(strategyConfigSchema));
  return (
    'You are the PunkLabz Terminal bot builder. You turn a plain-English trading idea into a strategy config for a paper-trading engine. The user may know NOTHING about coding or trading jargon — ask at most ONE clarifying question when the idea is too vague, otherwise just build it with sensible defaults.\n\n' +
    'Long-only spot strategies on BTCUSDT/ETHUSDT/SOLUSDT. You produce ONLY a JSON config matching this schema (never code):\n' +
    jsonSchema +
    '\n' + FEW_SHOT +
    '\nWhen you have enough to build, call the emit_strategy tool with the config. Also reply with 1-3 short sentences explaining what the bot will do in plain English (terminal/trading-desk tone, no emojis). If the user\'s request cannot be expressed in this schema (shorting, leverage, other coins, news triggers), say what you CAN build instead and build the closest thing only after they agree.'
  );
}

const EMIT_TOOL: Anthropic.Tool = {
  name: 'emit_strategy',
  description: 'Emit the completed strategy config for validation and preview.',
  input_schema: zodToJsonSchema(strategyConfigSchema) as Anthropic.Tool.InputSchema,
};

/**
 * One chat turn. If Claude emits a config that fails validation, the errors are
 * fed back for up to 3 repair rounds before giving up and asking the user.
 */
export async function builderChat(history: ChatMessage[]): Promise<BuilderTurn> {
  if (!config.anthropicApiKey) {
    return {
      assistantText: 'builder offline: server is missing ANTHROPIC_API_KEY',
      draftConfig: null,
      valid: false,
      errors: ['no api key'],
    };
  }
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

  let lastText = '';
  for (let round = 0; round < 3; round++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt(),
      tools: [EMIT_TOOL],
      messages,
    });
    const textBlock = res.content.find((b) => b.type === 'text');
    const toolBlock = res.content.find((b) => b.type === 'tool_use');
    lastText = textBlock?.text ?? lastText;

    if (!toolBlock || toolBlock.type !== 'tool_use') {
      // no config this turn — clarifying question or refusal
      return { assistantText: lastText || '…', draftConfig: null, valid: false, errors: [] };
    }

    const result = validateStrategyConfig(toolBlock.input);
    if (result.ok) {
      return { assistantText: lastText, draftConfig: result.config, valid: true, errors: [] };
    }

    // repair round: hand the validator errors back
    messages.push({ role: 'assistant', content: res.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: `Config rejected by validator:\n${result.errors.join('\n')}\nFix these and call emit_strategy again.`,
        is_error: true,
      }],
    });
  }

  return {
    assistantText:
      lastText || 'I could not produce a valid config for that. Try describing the entry and exit rules differently.',
    draftConfig: null,
    valid: false,
    errors: ['validation failed after 3 attempts'],
  };
}
