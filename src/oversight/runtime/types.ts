export type AuthorityState = 'agent_autonomous' | 'shared_supervision' | 'human_control';

export interface AuthorityContext {
  authorityState: AuthorityState;
  lastTransitionAt: number;
  transitionReason?: string;
}

export type ExecutionPhase = 'planning' | 'plan_review' | 'execution' | 'posthoc_review' | 'terminated';

export type ExecutionState = 'running' | 'paused_by_user' | 'paused_by_system' | 'cancelled' | 'completed';

export type PlanReviewDecision = 'approve' | 'edit' | 'reject';

export interface RuntimeStatusSnapshot {
  authorityState: AuthorityState;
  executionPhase: ExecutionPhase;
  executionState: ExecutionState;
  updatedAt: number;
}

export interface OversightRhythmMetrics {
  totalInterruptions: number;
  enforcedInterruptions: number;
  userInitiatedInterruptions: number;
  meanInterruptionIntervalMs: number;
  authorityTransitionCount: number;
}
