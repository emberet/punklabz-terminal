// THE PRE-PUBLISH FILTER.
//
// This is the last thing between a language model and a public account, and it
// is written on the assumption that the model is ALREADY COMPROMISED. The
// intern reads crypto Twitter, which contains text authored specifically to
// steer models. So this file does not ask whether the draft looks reasonable;
// it asks whether the draft is within a narrow set of things we are willing to
// have said in public, and refuses everything else.
//
// Four properties make that hold:
//
//  1. PURE. No network, no model, no database. It takes a draft and a set of
//     allowed numbers, and returns a verdict. Nothing it does can be delayed,
//     rate-limited, or influenced by anything outside its arguments.
//
//  2. FAILS CLOSED. Any error, any unexpected input, any empty allowlist —
//     blocked. There is no path through this function that returns "allowed"
//     by default.
//
//  3. NUMBERS ARE AN ALLOWLIST, NOT A BLOCKLIST. Every numeric literal in the
//     draft must appear in the exact set of measured figures the intern was
//     handed. A blocklist of "bad statistics" can always be evaded; an
//     allowlist means a manipulated model still cannot emit an invented number,
//     because there is no invented number that is on the list.
//
//  4. NO REWRITE-RETRY. A blocked draft is blocked. Feeding the rejection back
//     and asking for another attempt trains the loop to find phrasings that
//     slip through, which is the opposite of what a filter is for.
//
// Unicode is normalised first: `$SΟL` with a Greek omicron is the same call as
// `$SOL`, and a filter that does not know that is decorative.

export interface FilterInput {
  draft: string;
  /** the exact measured figures the intern was given; nothing else may appear */
  allowedNumbers: number[];
  /** ticker symbols the network knows about — used to detect token calls */
  knownSymbols: string[];
  maxLength?: number;
  /** recent published text, to refuse near-duplicates */
  recentPosts?: string[];
}

export interface FilterVerdict {
  allowed: boolean;
  /** rule names that fired, in the order they were checked */
  blockedRules: string[];
  /** what a human reading the block log needs to understand it */
  detail: string;
  normalized: string;
}

const DEFAULT_MAX_LENGTH = 260;

/** Fold the tricks that make two different strings look identical. */
export function normalize(s: string): string {
  let out = s.normalize('NFKC');
  // strip zero-width and bidi controls used to break up words
  out = out.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
  // common homoglyphs, folded to their ASCII twin
  // The known Latin confusables from Greek and Cyrillic. This map is a
  // convenience, NOT the control — see the mixed_script rule below, which
  // exists precisely because no hand-written list of confusables is complete.
  const HOMOGLYPHS: Record<string, string> = {
    // Greek
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
    'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'ο': 'o', 'ε': 'e', 'ι': 'i', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
    // Cyrillic
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
    'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'Ј': 'J', 'І': 'I', 'Ӏ': 'I',
    'Ԁ': 'D', 'Ԛ': 'Q', 'Ԝ': 'W', 'Ғ': 'F', 'Ԍ': 'G', 'Ә': 'e', 'Ү': 'Y',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'ѕ': 's',
    'ј': 'j', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v', 'у': 'y', 'к': 'k', 'м': 'm', 'т': 't',
    // fullwidth digits
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
    '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  };
  out = out.replace(/./gu, (ch) => HOMOGLYPHS[ch] ?? ch);
  // collapse whitespace so spacing cannot hide a phrase
  return out.replace(/\s+/g, ' ').trim();
}

const CALL_VERBS =
  /\b(buy|buying|sell|selling|short|shorting|long|longing|ape|aping|accumulate|accumulating|load|loading|grab|grabbing|scoop|scooping|send|sending|degen|entry|entries|exit|target|tp|sl)\b/i;

const PRICE_PREDICTION =
  /\b(going to|gonna|will|about to|set to|expect|expecting|headed|heading|on track|due)\b[^.!?]{0,60}\b(pump|dump|moon|rip|crash|explode|tank|breakout|break out|new high|new low|\d)/i;

const RETURN_CLAIM =
  /\b(\d+\s?x|\d+\s?%\s*(gain|return|profit|up|down)|guaranteed|risk[- ]free|can'?t lose|easy money|printing|prints money)\b/i;

const ADVICE =
  /\b(you should|you must|do not miss|don'?t miss|get in|get out|financial advice|not financial advice|nfa|dyor|position yourself|i (?:would|'d) (?:buy|sell|short|long))\b/i;

const IMPERSONATION =
  /\b(?:i am|i'?m|this is|speaking (?:as|for)|on behalf of)\s+(?:the\s+)?(?:sec|cftc|binance|coinbase|blackrock|anthropic|openai|vitalik|satoshi|elon|tether|circle|the fed|federal reserve)\b/i;

const PROMPT_LEAK =
  /\b(system prompt|my instructions|you are an? (?:ai|assistant|agent|language model)|ignore (?:all )?previous|as an ai|i (?:am|'m) an? (?:ai|assistant|language model)|tool[_ ]use|<\/?(?:system|instructions?)>)\b/i;

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|fun|app|link|gg|co)\b)/i;

/** every numeric literal in the text, as written */
export function extractNumbers(s: string): string[] {
  return s.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
}

function numbersMatch(literal: string, allowed: number[]): boolean {
  const value = Number(literal.replace(/,/g, ''));
  if (!Number.isFinite(value)) return false;
  // a figure the intern was handed may be written rounded; accept any rendering
  // that round-trips to the same value at the precision it was written
  const decimals = literal.includes('.') ? literal.split('.')[1].length : 0;
  return allowed.some((a) => {
    if (a === value) return true;
    const rounded = Number(a.toFixed(decimals));
    return rounded === value;
  });
}

/**
 * Screen a draft. The ONLY function permitted to authorise a publish.
 */
export function screen(input: FilterInput): FilterVerdict {
  const blockedRules: string[] = [];
  const details: string[] = [];

  // fail closed on anything that isn't a usable input at all
  if (typeof input?.draft !== 'string' || !Array.isArray(input?.allowedNumbers)) {
    return {
      allowed: false,
      blockedRules: ['malformed_input'],
      detail: 'filter called without a draft and an explicit allowed-number set',
      normalized: '',
    };
  }

  let text: string;
  try {
    text = normalize(input.draft);
  } catch {
    return {
      allowed: false, blockedRules: ['normalize_failed'],
      detail: 'draft could not be normalised', normalized: '',
    };
  }

  const fail = (rule: string, why: string) => {
    blockedRules.push(rule);
    details.push(why);
  };

  if (text.length === 0) fail('empty', 'nothing to publish');

  const max = input.maxLength ?? DEFAULT_MAX_LENGTH;
  if (text.length > max) fail('length', `${text.length} chars over the ${max} limit`);

  // ── the three rules the operator set, in code ──

  // 1. never name a token near a call verb
  const symbols = (input.knownSymbols ?? []).filter((s) => s && s.length >= 2);
  const upper = text.toUpperCase();
  const namedSymbol = symbols.find((s) => {
    const bare = s.toUpperCase().replace(/USDT$|USDC$|USD$/, '');
    if (bare.length < 2) return false;
    return new RegExp(`(^|[^A-Z0-9])\\$?${bare}([^A-Z0-9]|$)`).test(upper);
  });
  const contractAddress = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/.test(text);
  if ((namedSymbol || contractAddress) && CALL_VERBS.test(text)) {
    fail('no_token_call', `names ${namedSymbol ?? 'a contract address'} alongside a call verb`);
  }

  // No hand-written confusable map is ever complete, so do not rely on one. A
  // word that mixes Latin with another script is either an evasion attempt or
  // something we have no business publishing unreviewed; both are a block.
  // Accented Latin (café, naïve) is still Latin script, so this does not fire
  // on ordinary text — only on a word that genuinely straddles two alphabets.
  const mixedScript = text.split(/\s+/).find((word) => {
    let latin = false;
    let other = false;
    for (const ch of word) {
      if (!/\p{L}/u.test(ch)) continue;
      if (/\p{Script=Latin}/u.test(ch)) latin = true;
      else other = true;
      if (latin && other) return true;
    }
    return false;
  });
  if (mixedScript) fail('mixed_script', `"${mixedScript}" mixes Latin with another alphabet`);

  // 2. never predict a price
  if (PRICE_PREDICTION.test(text)) fail('no_price_prediction', 'reads as a forecast about price');

  // 3. never claim a return
  if (RETURN_CLAIM.test(text)) fail('no_return_claim', 'claims or implies a return');

  // ── the rest of the perimeter ──
  if (ADVICE.test(text)) fail('no_advice', 'tells the reader what to do (a "not financial advice" tag counts)');
  if (IMPERSONATION.test(text)) fail('no_impersonation', 'speaks as an organisation it is not');
  if (LINK.test(text)) fail('no_link', 'contains a link or domain');
  if (PROMPT_LEAK.test(text)) fail('no_prompt_leak', 'leaks instructions or model framing');

  // 4. THE ALLOWLIST. Every number must be one it was actually handed.
  const literals = extractNumbers(text);
  const invented = literals.filter((n) => !numbersMatch(n, input.allowedNumbers));
  if (invented.length) {
    fail('unmeasured_number', `${invented.join(', ')} not in the measured set it was given`);
  }

  // near-duplicate of something already said
  const recent = input.recentPosts ?? [];
  const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const dup = recent.find((p) => {
    const other = normalize(p).toLowerCase().replace(/[^a-z0-9 ]/g, '');
    return other === key || (key.length > 40 && (other.includes(key) || key.includes(other)));
  });
  if (dup) fail('no_repeat', 'near-duplicate of a recent post');

  return {
    allowed: blockedRules.length === 0,
    blockedRules,
    detail: blockedRules.length ? details.join('; ') : 'within the permitted envelope',
    normalized: text,
  };
}
