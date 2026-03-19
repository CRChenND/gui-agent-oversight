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

function normalizeSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function normalizeLower(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractTarget(toolInput: string): string {
  const trimmed = (toolInput || '').trim();
  if (!trimmed) return 'the page';
  const quoted = trimmed.match(/["']([^"']+)["']/)?.[1]?.trim();
  if (quoted) return quoted;
  const url = trimmed.match(/https?:\/\/[^\s'"]+/i)?.[0]?.trim();
  if (url) return url;
  const selector = trimmed.split(',')[0]?.trim();
  return selector || trimmed;
}

function describeToolAction(toolName: string, toolInput: string, stepDescription?: string): string {
  const target = extractTarget(toolInput);
  const normalizedStep = normalizeSentence(stepDescription || '');
  if (normalizedStep) return normalizedStep;

  const tool = toolName.toLowerCase();
  if (tool.includes('type') || tool.includes('fill')) {
    return normalizeSentence(`The agent wants to enter information into ${target}`);
  }
  if (tool.includes('click')) {
    return normalizeSentence(`The agent wants to click ${target}`);
  }
  if (tool.includes('navigate')) {
    return normalizeSentence(`The agent wants to open ${target}`);
  }
  if (tool.includes('read') || tool.includes('snapshot') || tool.includes('query') || tool.includes('screenshot')) {
    return normalizeSentence(`The agent wants to inspect ${target}`);
  }
  return normalizeSentence(`The agent wants to act on ${target}`);
}

function buildCombinedContext(toolInput: string, stepDescription?: string): string {
  return normalizeLower([toolInput, stepDescription].filter(Boolean).join(' '));
}

function mentionsSensitiveData(text: string): boolean {
  return /\b(password|passcode|credit card|cvv|ssn|social security|otp|2fa|token|api key|secret|bank|routing number)\b/i.test(text);
}

function mentionsSubmission(text: string): boolean {
  return /\b(submit|send|post|publish|confirm|checkout|purchase|pay|transfer|wire|book|order|message|save|update|apply)\b/i.test(text);
}

function mentionsPermissionOrConsent(text: string): boolean {
  return /\b(allow|permission|consent|authorize|grant access|connect|approve|accept)\b/i.test(text);
}

function mentionsAuthOrAccount(text: string): boolean {
  return /\b(login|log in|sign in|account|verification|verify|2fa|otp|security code|profile|settings)\b/i.test(text);
}

function mentionsNavigationBoundary(text: string): boolean {
  return /\b(redirect|external|new tab|new page|leave|continue|proceed|next)\b/i.test(text) || /https?:\/\//i.test(text);
}

function mentionsDeletionOrIrreversible(text: string): boolean {
  return /\b(delete|remove|drop|truncate|destroy|erase|unsubscribe|close account|deactivate)\b/i.test(text);
}

export function inferRiskAssessment(toolName: string, toolInput: string, _stepDescription?: string): RiskAssessment {
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

export function buildContextualRiskExplanation(args: {
  toolName: string;
  toolInput: string;
  impact: StepImpact;
  reversible?: boolean;
  category?: string;
  stepDescription?: string;
}): string {
  const { toolName, toolInput, impact, reversible, category, stepDescription } = args;
  const target = extractTarget(toolInput);
  const tool = toolName.toLowerCase();
  const action = describeToolAction(toolName, toolInput, stepDescription);
  const combinedContext = buildCombinedContext(toolInput, stepDescription);
  const sensitiveData = category === 'sensitive_data' || mentionsSensitiveData(combinedContext);
  const submission = category === 'destructive_or_external_side_effect' || mentionsSubmission(combinedContext);
  const permission = mentionsPermissionOrConsent(combinedContext);
  const auth = mentionsAuthOrAccount(combinedContext);
  const boundaryCrossing = mentionsNavigationBoundary(combinedContext);
  const irreversible = reversible === false || mentionsDeletionOrIrreversible(combinedContext);
  const actionPrefix = stepDescription?.trim() ? '' : `${action} `;

  if (tool.includes('read') || tool.includes('snapshot') || tool.includes('query') || tool.includes('screenshot')) {
    if (sensitiveData || auth) {
      return `${actionPrefix}Privacy review: this step appears observational, but it may expose sensitive account or credential information on ${target}. Check that the agent only reads the minimum details needed and does not use the observed data in a later submission.`;
    }
    return `${actionPrefix}Security review: this looks like a read-only inspection of ${target}, so the direct risk is low. The main thing to verify is that the agent is collecting the right context rather than inspecting unrelated user data.`;
  }

  if (tool.includes('type') || tool.includes('fill')) {
    if (sensitiveData) {
      return `${actionPrefix}Privacy review: the agent is about to place sensitive data into ${target}. Confirm the destination field is correct, the value is actually required for this task, and the page is the intended recipient before allowing the step.`;
    }
    if (auth) {
      return `${actionPrefix}Security review: writing into ${target} appears tied to authentication or account access. Verify the field belongs to the expected site flow and that the agent is not about to advance an account-level action with the wrong identity or settings.`;
    }
    return `${actionPrefix}Operational review: this step writes data into ${target}, so mistakes become stateful. Check that the field matches the current task context and that the value will not silently alter user settings, preferences, or downstream submissions.`;
  }

  if (tool.includes('click')) {
    if (submission || permission || irreversible) {
      return `${actionPrefix}Security review: clicking ${target} may immediately confirm an action, grant access, or create an external side effect. Verify what will happen after the click, whether this is the final confirmation point, and whether the user intended that consequence in this context.`;
    }
    if (auth) {
      return `${actionPrefix}Security review: clicking ${target} appears to move an authentication or account flow forward. Check that the agent is still on the correct account path and is not approving a login, verification, or settings change it has not fully inspected.`;
    }
    return `${actionPrefix}Context review: clicking ${target} changes workflow state. Confirm that this control advances the intended branch of the task rather than taking the agent into a different flow, modal, or form with new obligations.`;
  }

  if (tool.includes('navigate')) {
    if (boundaryCrossing || auth) {
      return `${actionPrefix}Security review: this navigation may move the agent across a trust boundary into a login, consent, or external page. Verify the destination is expected for the current task and that the next page is appropriate for handling any sensitive information.`;
    }
    return `${actionPrefix}Context review: navigation is usually lower risk than editing, but it changes the operating context. Confirm the destination page is the intended next step and not a detour that could confuse later actions or data entry.`;
  }

  if (category === 'destructive_or_external_side_effect' || submission || irreversible) {
    return `${actionPrefix}Security review: this step may trigger a real-world or hard-to-undo effect. Confirm the action target, the user intent behind it, and whether there is any safer intermediate check before execution.`;
  }

  if (category === 'sensitive_data' || sensitiveData) {
    return `${actionPrefix}Privacy review: this step appears to involve sensitive information. Confirm the data path is necessary, scoped to the current task, and limited to the expected recipient.`;
  }

  if (impact === 'low') {
    return `${actionPrefix}Context review: the direct risk looks low, but you should still confirm the agent is acting on the right element for the current task rather than drifting into unrelated page state.`;
  }
  if (impact === 'medium') {
    return `${actionPrefix}Context review: this step changes page state in a bounded way. The key check is whether the action matches the current task context and whether a small mismatch here would cascade into later errors.`;
  }
  return `${actionPrefix}Security review: this step has meaningful downside if the agent's context is wrong. Verify the target, expected side effect, and reversibility before allowing it to continue.`;
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
