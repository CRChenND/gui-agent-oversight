export type AuthorityState = 'agent_autonomous' | 'shared_supervision' | 'human_control';
export type OversightRegime = 'baseline' | 'deliberative_escalated';

export interface AuthorityContext {
  authorityState: AuthorityState;
  lastTransitionAt: number;
  transitionReason?: string;
}

export type ExecutionPhase = 'planning' | 'plan_review' | 'execution' | 'posthoc_review' | 'terminated';

export type ExecutionState = 'running' | 'paused_by_user' | 'paused_by_system' | 'cancelled' | 'completed';

export type PlanReviewDecision = 'approve' | 'edit' | 'reject';

export interface DeliberationState {
  score: number;
  lastSignalTimestamp: number;
  sustainedDurationMs: number;
  isDeliberative: boolean;
}

export interface RuntimePolicyState {
  monitoringContentScope: 'minimal' | 'standard' | 'full';
  explanationAvailability: 'none' | 'summary' | 'full';
  userActionOptions: 'basic' | 'extended';
  persistenceMs: number;
  tightenHighImpactAuthority: boolean;
}

export interface RuntimeStatusSnapshot {
  authorityState: AuthorityState;
  executionPhase: ExecutionPhase;
  executionState: ExecutionState;
  regime: OversightRegime;
  deliberation: DeliberationState;
  runtimePolicy: RuntimePolicyState;
  updatedAt: number;
}

export interface OversightRhythmMetrics {
  totalInterruptions: number;
  enforcedInterruptions: number;
  userInitiatedInterruptions: number;
  meanInterruptionIntervalMs: number;
  authorityTransitionCount: number;
}

export interface OversightEscalationMetrics {
  totalEscalations: number;
  meanEscalationDurationMs: number;
  maxEscalationDurationMs: number;
  escalationTriggerDistribution: {
    pause: number;
    trace_expand: number;
    hover: number;
    edit: number;
  };
  resolutionLatencyMs: number;
}
