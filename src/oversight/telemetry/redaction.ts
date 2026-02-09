import type { AgentThinkingSummary } from '../types';

export type TelemetryRedactionLevel = 'strict' | 'normal' | 'off';

interface RedactionConfig {
  level: TelemetryRedactionLevel;
  maxTextLength: number;
}

const DEFAULT_REDACTION_LEVEL: TelemetryRedactionLevel = 'normal';
const DEFAULT_MAX_TEXT_LENGTH = 320;
const STRICT_MAX_TEXT_LENGTH = 180;

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX =
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){1}\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

function clampArray(values: string[] | undefined, maxTextLength: number): string[] | undefined {
  if (!values || values.length === 0) return values;
  return values.map((value) => (value.length > maxTextLength ? `${value.slice(0, maxTextLength)}...` : value));
}

function redactText(text: string, maxTextLength: number): { value: string; redactions: string[] } {
  let value = text;
  const redactions = new Set<string>();

  if (EMAIL_REGEX.test(value)) {
    value = value.replace(EMAIL_REGEX, '[REDACTED_EMAIL]');
    redactions.add('email');
  }
  EMAIL_REGEX.lastIndex = 0;

  if (PHONE_REGEX.test(value)) {
    value = value.replace(PHONE_REGEX, '[REDACTED_PHONE]');
    redactions.add('phone');
  }
  PHONE_REGEX.lastIndex = 0;

  if (CREDIT_CARD_REGEX.test(value)) {
    value = value.replace(CREDIT_CARD_REGEX, '[REDACTED_CARD]');
    redactions.add('credit_card');
  }
  CREDIT_CARD_REGEX.lastIndex = 0;

  if (value.length > maxTextLength) {
    value = `${value.slice(0, maxTextLength)}...`;
    redactions.add('long_text');
  }

  return { value, redactions: Array.from(redactions) };
}

function resolveConfig(level: TelemetryRedactionLevel, maxTextLength?: number): RedactionConfig {
  if (level === 'strict') {
    return {
      level,
      maxTextLength: Math.max(40, maxTextLength ?? STRICT_MAX_TEXT_LENGTH),
    };
  }

  if (level === 'off') {
    return {
      level,
      maxTextLength: Number.MAX_SAFE_INTEGER,
    };
  }

  return {
    level: 'normal',
    maxTextLength: Math.max(40, maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH),
  };
}

export function redactThinking(
  thinking: AgentThinkingSummary,
  level: TelemetryRedactionLevel = DEFAULT_REDACTION_LEVEL,
  maxTextLength?: number
): AgentThinkingSummary {
  const config = resolveConfig(level, maxTextLength);
  if (config.level === 'off') {
    return {
      ...thinking,
      redactionsApplied: thinking.redactionsApplied ?? [],
    };
  }

  const redactions = new Set<string>(thinking.redactionsApplied ?? []);
  const redactField = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const result = redactText(value, config.maxTextLength);
    for (const item of result.redactions) redactions.add(item);
    return result.value;
  };

  return {
    ...thinking,
    goal: redactField(thinking.goal) ?? '',
    plan: clampArray(thinking.plan?.map((item) => redactField(item) ?? item), config.maxTextLength),
    memoryRead: clampArray(thinking.memoryRead?.map((item) => redactField(item) ?? item), config.maxTextLength),
    memoryWrite: clampArray(thinking.memoryWrite?.map((item) => redactField(item) ?? item), config.maxTextLength),
    rationale: redactField(thinking.rationale),
    riskFlags: clampArray(thinking.riskFlags?.map((item) => redactField(item) ?? item), config.maxTextLength),
    redactionsApplied: Array.from(redactions),
  };
}

export function enforceThinkingSizeLimit(
  thinking: AgentThinkingSummary,
  maxBytes = 2048
): AgentThinkingSummary {
  const estimateSize = (value: AgentThinkingSummary) => JSON.stringify(value).length;
  if (estimateSize(thinking) <= maxBytes) return thinking;

  const next: AgentThinkingSummary = { ...thinking };
  if (next.rationale && next.rationale.length > 120) {
    next.rationale = `${next.rationale.slice(0, 120)}...`;
  }
  if (next.plan && next.plan.length > 3) {
    next.plan = next.plan.slice(0, 3);
  }
  if (next.memoryRead && next.memoryRead.length > 3) {
    next.memoryRead = next.memoryRead.slice(0, 3);
  }
  if (next.memoryWrite && next.memoryWrite.length > 3) {
    next.memoryWrite = next.memoryWrite.slice(0, 3);
  }
  if (next.riskFlags && next.riskFlags.length > 3) {
    next.riskFlags = next.riskFlags.slice(0, 3);
  }

  if (estimateSize(next) <= maxBytes) return next;

  return {
    goal: next.goal.slice(0, 140),
    rationale: next.rationale ? next.rationale.slice(0, 160) : undefined,
    uncertainty: next.uncertainty,
    redactionsApplied: Array.from(new Set([...(next.redactionsApplied ?? []), 'size_limit'])),
  };
}

