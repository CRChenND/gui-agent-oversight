import type { AgentThinkingSummary } from '../../oversight/types';

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function extractRationale(accumulatedText: string): string | undefined {
  const withoutToolCall = accumulatedText
    .replace(/<tool>[\s\S]*?<\/requires_approval>/g, '')
    .replace(/```(?:xml|bash)/g, '')
    .replace(/```/g, '')
    .trim();
  if (!withoutToolCall) return undefined;
  return truncate(withoutToolCall.replace(/\s+/g, ' '), 280);
}

function sanitizeForPlan(accumulatedText: string): string {
  return accumulatedText
    .replace(/<tool>[\s\S]*?<\/requires_approval>/g, '')
    .replace(/<\/?(thinking_summary|impact|impact_rationale|assumptions|uncertainties|checkpoints)>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/```(?:xml|bash)/g, '')
    .replace(/```/g, '')
    .trim();
}

function extractPlanFromText(accumulatedText: string): string[] | undefined {
  const sanitized = sanitizeForPlan(accumulatedText);
  if (!sanitized) return undefined;

  const numberedOrBulleted = sanitized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:step\s*\d+[:.)-]?\s*|\d+[.)-]\s*|[-*]\s+)/i, '').trim())
    .filter((line) => line.length > 12)
    .filter((line) => !/^(low|medium|high)$/i.test(line));

  const uniqueSteps = Array.from(new Set(numberedOrBulleted)).slice(0, 5).map((line) => truncate(line, 160));
  if (uniqueSteps.length >= 2) return uniqueSteps;

  const sentenceParts = sanitized
    .split(/(?:\.\s+|\n+)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 12)
    .filter((part) => !/^(low|medium|high)$/i.test(part))
    .slice(0, 5)
    .map((part) => truncate(part, 160));

  if (sentenceParts.length > 0) return sentenceParts;
  return undefined;
}

function extractPlan(rationale: string | undefined, accumulatedText?: string): string[] | undefined {
  const fromText = extractPlanFromText(accumulatedText ?? '');
  if (fromText && fromText.length > 0) return fromText;
  if (!rationale) return undefined;
  const parts = rationale
    .split(/(?:\.\s+|\n+)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => truncate(part, 120));
  return parts.length > 0 ? parts : undefined;
}

function inferUncertainty(rationale: string | undefined): AgentThinkingSummary['uncertainty'] {
  if (!rationale) return 'med';
  const normalized = rationale.toLowerCase();
  if (/\b(maybe|might|unsure|uncertain|possibly)\b/.test(normalized)) return 'high';
  if (/\b(confirm|likely|probably)\b/.test(normalized)) return 'med';
  return 'low';
}

export function buildThinkingSummary(args: {
  goal: string;
  toolName?: string;
  toolInput?: string;
  accumulatedText?: string;
  modelThinkingSummary?: string;
}): AgentThinkingSummary {
  const fromModel = args.modelThinkingSummary?.trim();
  const rationale = fromModel ? truncate(fromModel, 280) : extractRationale(args.accumulatedText ?? '');
  const plan = extractPlan(rationale, args.accumulatedText);
  const riskFlags: string[] = [];

  const normalizedInput = (args.toolInput ?? '').toLowerCase();
  if (/\b(delete|purchase|submit|send|transfer|checkout)\b/.test(normalizedInput)) {
    riskFlags.push('destructive_or_external_side_effect');
  }
  if (/\b(password|credit card|ssn|token|api key)\b/.test(normalizedInput)) {
    riskFlags.push('sensitive_data');
  }

  return {
    goal: truncate(args.goal.trim() || 'Execute the current user request safely.', 200),
    plan,
    rationale,
    uncertainty: inferUncertainty(rationale),
    riskFlags: riskFlags.length > 0 ? riskFlags : undefined,
  };
}

export function createStepId(stepCounter: number): string {
  return `step_${stepCounter}_${Math.random().toString(36).slice(2, 8)}`;
}
