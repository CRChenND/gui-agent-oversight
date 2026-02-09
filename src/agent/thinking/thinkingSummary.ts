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

function extractPlan(rationale: string | undefined): string[] | undefined {
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
}): AgentThinkingSummary {
  const rationale = extractRationale(args.accumulatedText ?? '');
  const plan = extractPlan(rationale);
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

