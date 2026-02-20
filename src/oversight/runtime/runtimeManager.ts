import { getOversightSessionManager } from '../session/sessionManager';
import { getOversightTelemetryLogger } from '../telemetry/logger';
import type { OversightTelemetryEvent } from '../telemetry/types';
import { AuthorityManager } from './authorityManager';
import { ExecutionStateManager } from './executionStateManager';
import { PhaseManager } from './phaseManager';
import type {
  AuthorityState,
  ExecutionPhase,
  ExecutionState,
  PlanReviewDecision,
  RuntimeStatusSnapshot,
} from './types';

interface RuntimeBinding {
  tabId: number;
  windowId?: number;
}

interface RuntimeEventDispatcher {
  emitOversightEvent: (event: Record<string, unknown>, tabId: number, windowId?: number) => void;
  emitRuntimeState: (status: RuntimeStatusSnapshot, tabId: number, windowId?: number) => void;
}

interface PlanReviewPayload {
  planSummary: string;
  plan?: string[];
  stepId?: string;
  toolName?: string;
  toolInput?: string;
}

class OversightRuntimeManager {
  private authorityManager = new AuthorityManager();
  private phaseManager = new PhaseManager();
  private executionStateManager = new ExecutionStateManager();
  private bindings = new Map<string, RuntimeBinding>();
  private dispatcher: RuntimeEventDispatcher | null = null;

  setDispatcher(dispatcher: RuntimeEventDispatcher): void {
    this.dispatcher = dispatcher;
  }

  runtimeKey(windowId?: number | null): string {
    return `window:${windowId ?? 0}`;
  }

  private async logTelemetry(
    eventType: OversightTelemetryEvent['eventType'],
    payload: Record<string, unknown>
  ): Promise<void> {
    const sessionManager = getOversightSessionManager();
    const logger = getOversightTelemetryLogger();
    const sessionId = (await sessionManager.getActiveSessionId()) ?? (await sessionManager.startSession());
    logger.log({
      sessionId,
      timestamp: Date.now(),
      source: 'system',
      eventType,
      payload,
    });
  }

  private notifyRuntimeState(runtimeKey: string): void {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    this.dispatcher.emitRuntimeState(this.getSnapshot(runtimeKey), binding.tabId, binding.windowId);
  }

  private async emitAuthorityTransition(
    runtimeKey: string,
    from: AuthorityState,
    to: AuthorityState,
    reason: string
  ): Promise<void> {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: 'authority_transition', from, to, reason, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry('state_transition', {
      kind: 'authority_transition',
      from,
      to,
      reason,
      timestamp,
    });
  }

  private async emitPhaseChanged(runtimeKey: string, from: ExecutionPhase, to: ExecutionPhase, reason: string): Promise<void> {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: 'execution_phase_changed', from, to, reason, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry('state_transition', {
      kind: 'execution_phase_changed',
      from,
      to,
      reason,
      timestamp,
    });
  }

  private async emitExecutionStateChanged(
    runtimeKey: string,
    from: ExecutionState,
    to: ExecutionState,
    reason: string,
    by: 'user' | 'system'
  ): Promise<void> {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: 'execution_state_changed', from, to, reason, by, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry('state_transition', {
      kind: 'execution_state_changed',
      from,
      to,
      reason,
      by,
      timestamp,
    });
  }

  getSnapshot(runtimeKey: string): RuntimeStatusSnapshot {
    return {
      authorityState: this.authorityManager.getContext(runtimeKey).authorityState,
      executionPhase: this.phaseManager.getPhase(runtimeKey),
      executionState: this.executionStateManager.getState(runtimeKey),
      updatedAt: Date.now(),
    };
  }

  initializeRun(args: {
    tabId: number;
    windowId?: number;
    controlMode: 'approve_all' | 'risky_only' | 'step_through';
    gatePolicy?: 'never' | 'always' | 'impact' | 'adaptive';
  }): void {
    const key = this.runtimeKey(args.windowId);
    this.bindings.set(key, { tabId: args.tabId, windowId: args.windowId });
    const initialAuthority: AuthorityState =
      args.controlMode === 'step_through' || args.gatePolicy === 'adaptive' ? 'shared_supervision' : 'agent_autonomous';
    this.authorityManager.initialize(key, initialAuthority, `initialized_from_control_mode:${args.controlMode}`);
    this.phaseManager.setPhase(key, 'planning');
    this.executionStateManager.setState(key, 'running');
    void this.logTelemetry('state_transition', {
      kind: 'runtime_initialized',
      controlMode: args.controlMode,
      authorityState: initialAuthority,
      executionPhase: 'planning',
      executionState: 'running',
      timestamp: Date.now(),
    });
    this.notifyRuntimeState(key);
  }

  async transitionAuthority(windowId: number | undefined, to: AuthorityState, reason: string): Promise<void> {
    const key = this.runtimeKey(windowId);
    const transition = this.authorityManager.transition(key, to, reason);
    if (transition.changed) {
      await this.emitAuthorityTransition(key, transition.from, transition.to, reason);
      this.notifyRuntimeState(key);
    }
  }

  async setExecutionPhase(windowId: number | undefined, phase: ExecutionPhase, reason: string): Promise<void> {
    const key = this.runtimeKey(windowId);
    const transition = this.phaseManager.setPhase(key, phase);
    if (transition.changed) {
      await this.emitPhaseChanged(key, transition.from, transition.to, reason);
      this.notifyRuntimeState(key);
    }
  }

  async setExecutionState(
    windowId: number | undefined,
    state: ExecutionState,
    reason: string,
    by: 'user' | 'system'
  ): Promise<void> {
    const key = this.runtimeKey(windowId);
    const transition = this.executionStateManager.setState(key, state);
    if (transition.changed) {
      await this.emitExecutionStateChanged(key, transition.from, transition.to, reason, by);
      this.notifyRuntimeState(key);
    }
  }

  async requestPlanReview(windowId: number | undefined, payload: PlanReviewPayload): Promise<{ decision: PlanReviewDecision; editedPlan?: string }> {
    const key = this.runtimeKey(windowId);
    const binding = this.bindings.get(key);
    await this.setExecutionPhase(windowId, 'plan_review', 'await_human_plan_review');

    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(
        {
          kind: 'plan_review_requested',
          timestamp: Date.now(),
          planSummary: payload.planSummary,
          plan: payload.plan,
          stepId: payload.stepId,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
        },
        binding.tabId,
        binding.windowId
      );
      chrome.runtime.sendMessage({
        action: 'planReviewRequired',
        content: {
          runtimeKey: key,
          planSummary: payload.planSummary,
          plan: payload.plan,
          stepId: payload.stepId,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
        },
        tabId: binding.tabId,
        windowId: binding.windowId,
      });
    }

    return this.phaseManager.requestPlanReview(key);
  }

  async submitPlanReviewDecision(args: {
    windowId?: number;
    decision: PlanReviewDecision;
    editedPlan?: string;
  }): Promise<boolean> {
    const key = this.runtimeKey(args.windowId);
    const resolved = this.phaseManager.resolvePlanReview(key, args.decision, args.editedPlan);
    if (!resolved) return false;

    const edited = args.decision === 'edit';
    const timestamp = Date.now();
    const binding = this.bindings.get(key);
    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(
        {
          kind: 'plan_review_decision',
          decision: args.decision,
          edited,
          timestamp,
        },
        binding.tabId,
        binding.windowId
      );
    }
    await this.logTelemetry('human_intervention', {
      kind: 'plan_review_decision',
      decision: args.decision,
      edited,
      timestamp,
    });

    if (args.decision === 'reject') {
      await this.setExecutionState(args.windowId, 'cancelled', 'plan_rejected', 'user');
      await this.setExecutionPhase(args.windowId, 'terminated', 'plan_rejected');
    } else {
      await this.setExecutionPhase(args.windowId, 'execution', 'plan_approved');
    }
    return true;
  }

  async waitUntilExecutable(windowId: number | undefined): Promise<{ allowed: boolean; reason?: string }> {
    const key = this.runtimeKey(windowId);
    while (true) {
      const phase = this.phaseManager.getPhase(key);
      const executionState = this.executionStateManager.getState(key);

      if (phase !== 'execution') {
        return { allowed: false, reason: `Execution blocked by phase=${phase}` };
      }
      if (executionState === 'cancelled' || executionState === 'completed') {
        return { allowed: false, reason: `Execution blocked by state=${executionState}` };
      }
      if (executionState === 'running') {
        return { allowed: true };
      }

      const resumedState = await this.executionStateManager.waitUntilRunnable(key);
      if (resumedState === 'cancelled' || resumedState === 'completed') {
        return { allowed: false, reason: `Execution blocked by state=${resumedState}` };
      }
    }
  }

  async pauseByUser(windowId: number | undefined): Promise<void> {
    await this.setExecutionState(windowId, 'paused_by_user', 'user_pause', 'user');
    await this.transitionAuthority(windowId, 'human_control', 'user_pause');
    await this.logTelemetry('human_intervention', { kind: 'execution_paused', by: 'user', timestamp: Date.now() });
  }

  async resumeByUser(windowId: number | undefined): Promise<void> {
    await this.setExecutionState(windowId, 'running', 'user_resume', 'user');
    await this.transitionAuthority(windowId, 'shared_supervision', 'user_resume');
    await this.logTelemetry('human_intervention', { kind: 'execution_resumed', by: 'user', timestamp: Date.now() });
  }

  async takeover(windowId: number | undefined): Promise<void> {
    const key = this.runtimeKey(windowId);
    const previous = this.authorityManager.getContext(key).authorityState;
    await this.setExecutionState(windowId, 'paused_by_user', 'authority_takeover', 'user');
    await this.transitionAuthority(windowId, 'human_control', 'user_takeover');
    await this.logTelemetry('human_intervention', {
      kind: 'authority_takeover',
      previous,
      timestamp: Date.now(),
    });
  }

  async releaseControl(windowId: number | undefined): Promise<void> {
    await this.transitionAuthority(windowId, 'agent_autonomous', 'user_release_control');
    await this.setExecutionState(windowId, 'running', 'user_release_control', 'user');
  }

  async resolveEscalation(windowId: number | undefined): Promise<void> {
    await this.transitionAuthority(windowId, 'agent_autonomous', 'escalation_resolved');
  }

  async handleAdaptiveRiskSignal(args: {
    windowId: number | undefined;
    gatePolicy?: string;
    promptedByGate?: boolean;
    impact?: string;
  }): Promise<void> {
    if (args.gatePolicy !== 'adaptive') return;

    if (args.promptedByGate) {
      await this.transitionAuthority(args.windowId, 'shared_supervision', 'adaptive_escalation_triggered');
      return;
    }

    if (args.impact === 'low') {
      await this.transitionAuthority(args.windowId, 'agent_autonomous', 'adaptive_escalation_resolved');
    }
  }

  async markRunCompleted(windowId: number | undefined): Promise<void> {
    await this.setExecutionState(windowId, 'completed', 'run_completed', 'system');
    await this.setExecutionPhase(windowId, 'posthoc_review', 'run_completed');
  }

  async markRunCancelled(windowId: number | undefined): Promise<void> {
    await this.setExecutionState(windowId, 'cancelled', 'run_cancelled', 'system');
    await this.setExecutionPhase(windowId, 'terminated', 'run_cancelled');
  }

  async markRunFailed(windowId: number | undefined): Promise<void> {
    await this.setExecutionState(windowId, 'cancelled', 'run_failed', 'system');
    await this.setExecutionPhase(windowId, 'terminated', 'run_failed');
  }

  clear(windowId: number | undefined): void {
    const key = this.runtimeKey(windowId);
    this.authorityManager.clear(key);
    this.phaseManager.clear(key);
    this.executionStateManager.clear(key);
    this.bindings.delete(key);
  }
}

let runtimeManagerSingleton: OversightRuntimeManager | null = null;

export function getOversightRuntimeManager(): OversightRuntimeManager {
  if (!runtimeManagerSingleton) {
    runtimeManagerSingleton = new OversightRuntimeManager();
  }
  return runtimeManagerSingleton;
}
