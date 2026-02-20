export type AttentionFocusType = 'selector' | 'coordinates' | 'url' | 'text' | 'none';
export type StepImpact = 'low' | 'medium' | 'high';
export type AuthorityState = 'agent_autonomous' | 'shared_supervision' | 'human_control';
export type ExecutionPhase = 'planning' | 'plan_review' | 'execution' | 'posthoc_review' | 'terminated';
export type ExecutionState = 'running' | 'paused_by_user' | 'paused_by_system' | 'cancelled' | 'completed';

export type OversightLevel = 'observe' | 'impact_gated' | 'stepwise';

export interface StepContextEvent {
  kind: 'step_context';
  stepId: string;
  impact: StepImpact;
  reversible?: boolean;
  gold_risky: boolean;
  category?: string;
}

export type InterventionEvent =
  | { kind: 'intervention_prompted'; stepId: string }
  | { kind: 'intervention_decision'; stepId: string; decision: 'approve' | 'deny' | 'edit' | 'rollback' };

export interface AgentThinkingSummary {
  goal: string;
  plan?: string[];
  memoryRead?: string[];
  memoryWrite?: string[];
  rationale?: string;
  uncertainty?: 'low' | 'med' | 'high';
  riskFlags?: string[];
  redactionsApplied?: string[];
}

export interface RiskSignalEvent {
  kind: 'risk_signal';
  timestamp: number;
  stepId: string;
  toolName: string;
  signal: Record<string, unknown>;
}

export type OversightEvent =
  | StepContextEvent
  | RiskSignalEvent
  | InterventionEvent
  | {
      kind: 'oversight_level_changed';
      from: OversightLevel;
      to: OversightLevel;
      reason: string;
      timestamp: number;
    }
  | {
      kind: 'tool_started';
      timestamp: number;
      stepId: string;
      toolName: string;
      toolInput: string;
      focusType: AttentionFocusType;
      focusLabel: string;
    }
  | {
      kind: 'agent_thinking';
      timestamp: number;
      stepId: string;
      toolName?: string;
      thinking: AgentThinkingSummary;
    }
  | {
      kind: 'run_completed';
      timestamp: number;
      focusLabel: string;
    }
  | {
      kind: 'run_cancelled';
      timestamp: number;
      focusLabel: string;
    }
  | {
      kind: 'run_failed';
      timestamp: number;
      focusLabel: string;
      error?: string;
    }
  | {
      kind: 'authority_transition';
      from: AuthorityState;
      to: AuthorityState;
      reason: string;
      timestamp: number;
    }
  | {
      kind: 'execution_phase_changed';
      from: ExecutionPhase;
      to: ExecutionPhase;
      reason: string;
      timestamp: number;
    }
  | {
      kind: 'execution_state_changed';
      from: ExecutionState;
      to: ExecutionState;
      reason: string;
      by: 'user' | 'system';
      timestamp: number;
    }
  | {
      kind: 'plan_review_requested';
      timestamp: number;
      planSummary: string;
      plan?: string[];
      stepId?: string;
      toolName?: string;
      toolInput?: string;
    }
  | {
      kind: 'plan_review_decision';
      decision: 'approve' | 'edit' | 'reject';
      edited: boolean;
      timestamp: number;
    };
