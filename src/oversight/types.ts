export type AttentionFocusType = 'selector' | 'coordinates' | 'url' | 'text' | 'none';

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

export type OversightEvent =
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
