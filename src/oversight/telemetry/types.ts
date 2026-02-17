import type { InterventionEvent, OversightLevel, StepContextEvent } from '../types';

export type StepOutcomeTelemetryEvent = {
  kind: 'step_outcome';
  stepId: string;
  executed: boolean;
  blockedByUser: boolean;
};

export type OversightLevelChangedTelemetryEvent = {
  kind: 'oversight_level_changed';
  from: OversightLevel;
  to: OversightLevel;
  reason: string;
};

export type OversightTelemetryPayloadEvent =
  | StepContextEvent
  | InterventionEvent
  | StepOutcomeTelemetryEvent
  | OversightLevelChangedTelemetryEvent
  | Record<string, any>;

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
  payload: Record<string, any> & Partial<OversightTelemetryPayloadEvent>;
}
