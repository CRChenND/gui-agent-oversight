export interface OversightTelemetryEvent {
  sessionId: string;
  timestamp: number;
  source: 'agent' | 'human' | 'system';
  eventType:
    | 'agent_action'
    | 'agent_thinking'
    | 'oversight_signal'
    | 'human_intervention'
    | 'human_monitoring'
    | 'state_transition';
  payload: Record<string, any>;
}
