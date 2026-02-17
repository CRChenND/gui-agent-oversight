export type AttentionFocusType = 'selector' | 'coordinates' | 'url' | 'text' | 'none';
export type StepImpact = 'low' | 'medium' | 'high';

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
    };
