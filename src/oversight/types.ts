export type AttentionFocusType = 'selector' | 'coordinates' | 'url' | 'text' | 'none';

export type OversightEvent =
  | {
      kind: 'tool_started';
      timestamp: number;
      toolName: string;
      toolInput: string;
      focusType: AttentionFocusType;
      focusLabel: string;
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
