import type { OversightLevel, StepImpact } from './types';

export type InterventionGatePolicy = 'never' | 'always' | 'impact' | 'adaptive';

export interface RiskAssessment {
  impact: StepImpact;
  reversible: boolean;
  gold_risky: boolean;
  category?: string;
  reasons: string[];
}

export interface AdaptiveGateState {
  currentLevel: OversightLevel;
  recentRiskEvents: number;
  lowRiskNoInterventionStreak: number;
  consecutiveApprovals: number;
}

export const INITIAL_ADAPTIVE_GATE_STATE: AdaptiveGateState = {
  currentLevel: 'observe',
  recentRiskEvents: 0,
  lowRiskNoInterventionStreak: 0,
  consecutiveApprovals: 0,
};

const READ_ONLY_TOOLS = new Set([
  'browser_get_title',
  'browser_snapshot_dom',
  'browser_query',
  'browser_accessible_tree',
  'browser_read_text',
  'browser_screenshot',
  'browser_screenshot_tab',
  'browser_tab_list',
  'browser_get_active_tab',
]);

const HIGH_RISK_TOOL_HINTS = new Set([
  'browser_handle_dialog',
  'browser_tab_close',
  'browser_click_xy',
  'browser_drag',
]);

const HIGH_RISK_INPUT_PATTERNS: Array<{ regex: RegExp; reason: string; category: string }> = [
  {
    regex: /\b(delete|remove|drop|truncate|destroy|erase|confirm deletion)\b/i,
    reason: 'Input suggests destructive action.',
    category: 'destructive_or_external_side_effect',
  },
  {
    regex: /\b(send|submit|post|publish|checkout|purchase|pay|transfer|wire|book|order|message)\b/i,
    reason: 'Input suggests externally visible side effect.',
    category: 'destructive_or_external_side_effect',
  },
  {
    regex: /\b(password|passcode|credit card|cvv|ssn|social security|otp|2fa|token|api key|secret)\b/i,
    reason: 'Input references sensitive data.',
    category: 'sensitive_data',
  },
];

const MEDIUM_RISK_INPUT_PATTERN = /\b(login|sign in|form|confirm|continue|next|allow|permission|consent)\b/i;

export function inferRiskAssessment(toolName: string, toolInput: string): RiskAssessment {
  const normalizedInput = (toolInput || '').toLowerCase();
  const reasons: string[] = [];
  let impact: StepImpact = 'medium';
  let category: string | undefined;
  let reversible = true;
  let goldRisky = false;

  if (READ_ONLY_TOOLS.has(toolName)) {
    impact = 'low';
    reasons.push('Read-only observation tool.');
  } else if (toolName === 'browser_navigate' || toolName === 'browser_navigate_tab') {
    impact = 'low';
    reasons.push('Navigation-only action.');
  } else {
    reasons.push('Interactive tool can modify page state.');
  }

  if (HIGH_RISK_TOOL_HINTS.has(toolName)) {
    impact = 'high';
    goldRisky = true;
    reversible = false;
    category = 'destructive_or_external_side_effect';
    reasons.push('Tool is commonly associated with irreversible effects.');
  }

  for (const pattern of HIGH_RISK_INPUT_PATTERNS) {
    if (pattern.regex.test(normalizedInput)) {
      impact = 'high';
      goldRisky = true;
      reversible = false;
      category = pattern.category;
      reasons.push(pattern.reason);
    }
  }

  if (impact !== 'high' && MEDIUM_RISK_INPUT_PATTERN.test(normalizedInput)) {
    impact = 'medium';
    reasons.push('Input indicates potentially consequential interaction.');
  }

  if (impact === 'low') {
    goldRisky = false;
    reversible = true;
  }

  return {
    impact,
    reversible,
    gold_risky: goldRisky,
    category,
    reasons,
  };
}

export function shouldPromptByGatePolicy(
  policy: InterventionGatePolicy,
  risk: RiskAssessment,
  adaptiveLevel: OversightLevel
): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'impact') return risk.impact === 'high';
  if (adaptiveLevel === 'stepwise') return true;
  if (adaptiveLevel === 'impact_gated') return risk.impact === 'high';
  return false;
}

export function updateAdaptiveStateFromStep(
  previous: AdaptiveGateState,
  risk: RiskAssessment,
  promptedByGate: boolean
): AdaptiveGateState {
  let nextLevel = previous.currentLevel;
  if (risk.impact === 'high' && nextLevel === 'observe') {
    nextLevel = 'impact_gated';
  }

  const missedHighRisk = risk.impact === 'high' && risk.gold_risky && !promptedByGate;
  const recentRiskEvents = missedHighRisk ? previous.recentRiskEvents + 1 : Math.max(0, previous.recentRiskEvents - 1);
  const lowRiskNoInterventionStreak = risk.impact === 'low' && !promptedByGate ? previous.lowRiskNoInterventionStreak + 1 : 0;

  if (recentRiskEvents >= 2) {
    nextLevel = 'stepwise';
  }

  if (lowRiskNoInterventionStreak >= 5) {
    if (nextLevel === 'stepwise') {
      nextLevel = 'impact_gated';
    } else if (nextLevel === 'impact_gated') {
      nextLevel = 'observe';
    }
  }

  return {
    ...previous,
    currentLevel: nextLevel,
    recentRiskEvents,
    lowRiskNoInterventionStreak,
  };
}

export function updateAdaptiveStateFromDecision(
  previous: AdaptiveGateState,
  decision: 'approve' | 'deny'
): AdaptiveGateState {
  return {
    ...previous,
    consecutiveApprovals: decision === 'approve' ? previous.consecutiveApprovals + 1 : 0,
  };
}
