import { getOversightSessionManager } from '../session/sessionManager';
import { getOversightTelemetryLogger } from '../telemetry/logger';
import type { OversightTelemetryEvent } from '../telemetry/types';
import {
  AmplificationManager,
  type AmplificationConfig,
  type AmplificationSignal,
} from './amplificationManager';
import { AuthorityManager } from './authorityManager';
import {
  DeliberationManager,
  type BehavioralSignalType,
  type DeliberationConfig,
} from './deliberationManager';
import { ExecutionStateManager } from './executionStateManager';
import { PhaseManager } from './phaseManager';
import { RegimePolicyAdapter } from './regimePolicyAdapter';
import { RegimeManager, type RegimeConfig, type RegimeTransitionEvent } from './regimeManager';
import type {
  AmplificationEnterReason,
  AuthorityState,
  ExecutionPhase,
  ExecutionState,
  OversightRegime,
  PlanReviewDecision,
  RuntimePolicyState,
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

interface StructuralAmplificationRuntimeConfig {
  enabled: boolean;
  deliberationThreshold: number;
  signalDecayMs: number;
  sustainedWindowMs: number;
  resolutionWindowMs: number;
  escalationPersistenceMs: number;
  rapidPauseResumeWindowMs: number;
  traceExpansionWindowMs: number;
  inactivityExitSteps: number;
  intentRefreshEverySteps: number;
  softPauseDurationMs: number;
  intentRefreshAutoConfirmMs: number;
}

interface SoftPauseContext {
  active: boolean;
  startedAt: number;
  endsAt: number;
  timeoutMs: number;
  stepId?: string;
  toolName?: string;
  timer?: ReturnType<typeof setTimeout>;
  resolver?: (value: { allowed: boolean; reason?: string }) => void;
}

interface NavigationContext {
  lastOrigin?: string;
}

class OversightRuntimeManager {
  private authorityManager = new AuthorityManager();
  private phaseManager = new PhaseManager();
  private executionStateManager = new ExecutionStateManager();
  private amplificationManager = new AmplificationManager();
  private deliberationManager = new DeliberationManager();
  private regimeManager = new RegimeManager();
  private regimePolicyAdapter = new RegimePolicyAdapter();
  private bindings = new Map<string, RuntimeBinding>();
  private structuralAmplificationConfig = new Map<string, StructuralAmplificationRuntimeConfig>();
  private softPauseContexts = new Map<string, SoftPauseContext>();
  private navigationContexts = new Map<string, NavigationContext>();
  private intentRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private regimeResolutionTimers = new Map<string, ReturnType<typeof setInterval>>();
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

  private async emitBehavioralEvent(
    runtimeKey: string,
    event: Record<string, any>,
    telemetryType: OversightTelemetryEvent['eventType']
  ): Promise<void> {
    const binding = this.bindings.get(runtimeKey);
    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(event, binding.tabId, binding.windowId);
    }
    await this.logTelemetry(telemetryType, {
      ...event,
      escalationPath: 'behavioral',
    });
  }

  private async emitAmplificationEvent(runtimeKey: string, event: Record<string, unknown>): Promise<void> {
    const binding = this.bindings.get(runtimeKey);
    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(event, binding.tabId, binding.windowId);
    }
    await this.logTelemetry('state_transition', event);
  }

  private normalizeAmplificationConfig(config: StructuralAmplificationRuntimeConfig): AmplificationConfig {
    return {
      enabled: config.enabled,
      rapidPauseResumeWindowMs: Math.max(1, config.rapidPauseResumeWindowMs),
      traceExpansionWindowMs: Math.max(1, config.traceExpansionWindowMs),
      inactivityExitSteps: Math.max(1, config.inactivityExitSteps),
      intentRefreshEverySteps: Math.max(1, config.intentRefreshEverySteps),
    };
  }

  private normalizeDeliberationConfig(config: StructuralAmplificationRuntimeConfig): DeliberationConfig {
    return {
      enabled: config.enabled,
      deliberationThreshold: Math.max(1, config.deliberationThreshold),
      signalDecayMs: Math.max(1, config.signalDecayMs),
      sustainedWindowMs: Math.max(1, config.sustainedWindowMs),
    };
  }

  private normalizeRegimeConfig(config: StructuralAmplificationRuntimeConfig): RegimeConfig {
    return {
      enabled: config.enabled,
      resolutionWindowMs: Math.max(0, config.resolutionWindowMs),
    };
  }

  private clearIntentRefreshTimer(runtimeKey: string): void {
    const timer = this.intentRefreshTimers.get(runtimeKey);
    if (timer) {
      clearTimeout(timer);
      this.intentRefreshTimers.delete(runtimeKey);
    }
  }

  private clearSoftPause(runtimeKey: string): void {
    const context = this.softPauseContexts.get(runtimeKey);
    if (context?.timer) {
      clearTimeout(context.timer);
    }
    if (context?.resolver) {
      context.resolver({ allowed: false, reason: 'Soft pause cleared' });
    }
    this.softPauseContexts.delete(runtimeKey);
  }

  private async handleAmplificationEvents(runtimeKey: string, events: Record<string, any>[]): Promise<void> {
    for (const event of events) {
      if (event.kind === 'intent_refresh_triggered') {
        await this.emitAmplificationEvent(runtimeKey, event);
        this.clearIntentRefreshTimer(runtimeKey);
        const config = this.structuralAmplificationConfig.get(runtimeKey);
        const autoConfirmMs = Math.max(0, Number(config?.intentRefreshAutoConfirmMs ?? 1500));
        const timer = setTimeout(() => {
          void this.emitAmplificationEvent(runtimeKey, {
            kind: 'intent_refresh_confirmed',
            timestamp: Date.now(),
            response: 'yes_auto',
          });
        }, autoConfirmMs);
        this.intentRefreshTimers.set(runtimeKey, timer);
        continue;
      }
      await this.emitAmplificationEvent(runtimeKey, event);
    }
    this.notifyRuntimeState(runtimeKey);
  }

  private getRegime(runtimeKey: string): OversightRegime {
    return this.regimeManager.getRegime(runtimeKey);
  }

  private applyRuntimePolicy(runtimeKey: string): void {
    const config = this.structuralAmplificationConfig.get(runtimeKey);
    const escalationPersistenceMs = Math.max(0, config?.escalationPersistenceMs ?? 300000);
    this.regimePolicyAdapter.apply(runtimeKey, this.getRegime(runtimeKey), { escalationPersistenceMs });
  }

  private async handleRegimeTransition(runtimeKey: string, transition: RegimeTransitionEvent): Promise<void> {
    const telemetryType: OversightTelemetryEvent['eventType'] = 'state_transition';
    await this.emitBehavioralEvent(runtimeKey, transition, telemetryType);

    if (transition.to === 'baseline') {
      const resolvedEvents = this.deliberationManager.resolveForInactivity(runtimeKey, transition.timestamp);
      for (const event of resolvedEvents) {
        await this.emitBehavioralEvent(runtimeKey, event, 'oversight_signal');
      }
    }

    this.applyRuntimePolicy(runtimeKey);
    this.notifyRuntimeState(runtimeKey);
  }

  private async reconcileRegime(runtimeKey: string, timestamp: number): Promise<void> {
    const config = this.structuralAmplificationConfig.get(runtimeKey);
    if (!config) return;

    const transition = this.regimeManager.update(
      runtimeKey,
      this.deliberationManager.getState(runtimeKey),
      this.normalizeRegimeConfig(config),
      timestamp
    );

    if (transition) {
      await this.handleRegimeTransition(runtimeKey, transition);
      return;
    }

    this.applyRuntimePolicy(runtimeKey);
    this.notifyRuntimeState(runtimeKey);
  }

  private startRegimeResolutionMonitor(runtimeKey: string): void {
    this.stopRegimeResolutionMonitor(runtimeKey);
    const timer = setInterval(() => {
      const config = this.structuralAmplificationConfig.get(runtimeKey);
      if (!config?.enabled) return;
      if (this.regimeManager.getRegime(runtimeKey) !== 'deliberative_escalated') return;
      void this.reconcileRegime(runtimeKey, Date.now());
    }, 1000);
    this.regimeResolutionTimers.set(runtimeKey, timer);
  }

  private stopRegimeResolutionMonitor(runtimeKey: string): void {
    const timer = this.regimeResolutionTimers.get(runtimeKey);
    if (timer) {
      clearInterval(timer);
      this.regimeResolutionTimers.delete(runtimeKey);
    }
  }

  getSnapshot(runtimeKey: string): RuntimeStatusSnapshot {
    const amplification = this.amplificationManager.getState(runtimeKey);
    const softPause = this.softPauseContexts.get(runtimeKey);
    return {
      authorityState: this.authorityManager.getContext(runtimeKey).authorityState,
      executionPhase: this.phaseManager.getPhase(runtimeKey),
      executionState: this.executionStateManager.getState(runtimeKey),
      regime: this.regimeManager.getRegime(runtimeKey),
      amplification: {
        state: amplification.state,
        enteredAt: amplification.enteredAt,
        enteredReason: amplification.enteredReason,
        entryCount: amplification.entryCount,
      },
      softPause: softPause
        ? {
            active: softPause.active,
            startedAt: softPause.startedAt,
            endsAt: softPause.endsAt,
            timeoutMs: softPause.timeoutMs,
            stepId: softPause.stepId,
            toolName: softPause.toolName,
          }
        : undefined,
      deliberation: this.deliberationManager.getState(runtimeKey),
      runtimePolicy: this.regimePolicyAdapter.getEffectivePolicy(runtimeKey),
      updatedAt: Date.now(),
    };
  }

  initializeRun(args: {
    tabId: number;
    windowId?: number;
    controlMode: 'approve_all' | 'risky_only' | 'step_through';
    gatePolicy?: 'never' | 'always' | 'impact' | 'adaptive';
    structuralAmplification?: {
      enabled: boolean;
      deliberationThreshold?: number;
      signalDecayMs?: number;
      sustainedWindowMs?: number;
      resolutionWindowMs?: number;
      escalationPersistenceMs?: number;
    };
    runtimePolicyBaseline?: RuntimePolicyState;
  }): void {
    const key = this.runtimeKey(args.windowId);
    this.bindings.set(key, { tabId: args.tabId, windowId: args.windowId });
    const initialAuthority: AuthorityState =
      args.controlMode === 'step_through' || args.gatePolicy === 'adaptive' ? 'shared_supervision' : 'agent_autonomous';

    const structuralConfig: StructuralAmplificationRuntimeConfig = {
      enabled: Boolean(args.structuralAmplification?.enabled),
      deliberationThreshold: Math.max(1, Number(args.structuralAmplification?.deliberationThreshold ?? 3)),
      signalDecayMs: Math.max(1, Number(args.structuralAmplification?.signalDecayMs ?? 10000)),
      sustainedWindowMs: Math.max(1, Number(args.structuralAmplification?.sustainedWindowMs ?? 10000)),
      resolutionWindowMs: Math.max(0, Number(args.structuralAmplification?.resolutionWindowMs ?? 15000)),
      escalationPersistenceMs: Math.max(0, Number(args.structuralAmplification?.escalationPersistenceMs ?? 300000)),
      rapidPauseResumeWindowMs: 5000,
      traceExpansionWindowMs: 8000,
      inactivityExitSteps: 3,
      intentRefreshEverySteps: 3,
      softPauseDurationMs: 0,
      intentRefreshAutoConfirmMs: 1500,
    };

    this.structuralAmplificationConfig.set(key, structuralConfig);

    this.authorityManager.initialize(key, initialAuthority, `initialized_from_control_mode:${args.controlMode}`);
    this.phaseManager.setPhase(key, 'planning');
    this.executionStateManager.setState(key, 'running');
    this.amplificationManager.initialize(key);
    this.deliberationManager.initialize(key);
    this.regimeManager.initialize(key);
    this.navigationContexts.set(key, {});

    this.regimePolicyAdapter.initialize(
      key,
      args.runtimePolicyBaseline ?? {
        monitoringContentScope: 'standard',
        explanationAvailability: 'summary',
        userActionOptions: 'basic',
        persistenceMs: 0,
        tightenHighImpactAuthority: false,
      }
    );

    this.applyRuntimePolicy(key);

    if (structuralConfig.enabled) {
      this.startRegimeResolutionMonitor(key);
    }

    void this.logTelemetry('state_transition', {
      kind: 'runtime_initialized',
      controlMode: args.controlMode,
      authorityState: initialAuthority,
      executionPhase: 'planning',
      executionState: 'running',
      regime: this.regimeManager.getRegime(key),
      structuralAmplificationEnabled: structuralConfig.enabled,
      amplificationState: 'normal',
      timestamp: Date.now(),
    });
    this.notifyRuntimeState(key);
  }

  async handleBehavioralSignal(args: {
    windowId: number | undefined;
    signal: BehavioralSignalType;
    durationMs?: number;
    source?: 'ui' | 'runtime';
  }): Promise<void> {
    const runtimeKey = this.runtimeKey(args.windowId);
    const config = this.structuralAmplificationConfig.get(runtimeKey);
    if (!config?.enabled) return;

    const timestamp = Date.now();
    const amplificationSignal = args.signal as AmplificationSignal;
    const amplificationEvents = this.amplificationManager.registerSignal(
      runtimeKey,
      amplificationSignal,
      this.normalizeAmplificationConfig(config),
      timestamp
    );
    if (amplificationEvents.length > 0) {
      await this.handleAmplificationEvents(runtimeKey, amplificationEvents);
    }

    const deliberation = this.deliberationManager.registerSignal(
      runtimeKey,
      args.signal,
      this.normalizeDeliberationConfig(config),
      timestamp
    );

    for (const event of deliberation.events) {
      await this.emitBehavioralEvent(runtimeKey, event, 'oversight_signal');
    }

    await this.logTelemetry('oversight_signal', {
      kind: 'behavioral_signal_captured',
      signal: args.signal,
      durationMs: typeof args.durationMs === 'number' ? Math.max(0, args.durationMs) : undefined,
      source: args.source ?? 'ui',
      timestamp,
      escalationPath: 'behavioral',
    });

    await this.reconcileRegime(runtimeKey, timestamp);
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
      if (phase === 'posthoc_review') {
        const events = this.amplificationManager.exitForTaskBoundary(key, Date.now());
        if (events.length > 0) {
          await this.handleAmplificationEvents(key, events);
        }
      }
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
    console.log('[structural-debug] submitPlanReviewDecision', {
      windowId: args.windowId,
      runtimeKey: key,
      decision: args.decision,
      editedPlanLength: args.editedPlan?.length ?? 0,
    });
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

  getAmplificationStatus(windowId: number | undefined): {
    state: 'normal' | 'amplified';
    enteredReason?: AmplificationEnterReason;
  } {
    const key = this.runtimeKey(windowId);
    const state = this.amplificationManager.getState(key);
    return {
      state: state.state,
      enteredReason: state.enteredReason,
    };
  }

  async waitForSoftPauseWindow(args: {
    windowId: number | undefined;
    stepId?: string;
    toolName?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const key = this.runtimeKey(args.windowId);
    const config = this.structuralAmplificationConfig.get(key);
    const amplification = this.amplificationManager.getState(key);
    if (!config?.enabled || amplification.state !== 'amplified') {
      return { allowed: true };
    }

    const existing = this.softPauseContexts.get(key);
    if (existing?.active && existing.resolver) {
      return new Promise((resolve) => {
        const previousResolver = existing.resolver!;
        existing.resolver = (value) => {
          previousResolver(value);
          resolve(value);
        };
      });
    }

    const timeoutMs = Math.max(0, Number(config.softPauseDurationMs || 0));
    if (timeoutMs <= 0) {
      return { allowed: true };
    }
    const startedAt = Date.now();
    const endsAt = startedAt + timeoutMs;
    console.log('[structural-debug] softPauseStarting', {
      windowId: args.windowId,
      runtimeKey: key,
      stepId: args.stepId,
      toolName: args.toolName,
      timeoutMs,
    });

    await this.setExecutionState(args.windowId, 'paused_by_system_soft', 'amplification_soft_pause', 'system');
    await this.logTelemetry('state_transition', {
      kind: 'soft_pause_started',
      timestamp: startedAt,
      timeoutMs,
      stepId: args.stepId,
      toolName: args.toolName,
    });

    return new Promise((resolve) => {
      const context: SoftPauseContext = {
        active: true,
        startedAt,
        endsAt,
        timeoutMs,
        stepId: args.stepId,
        toolName: args.toolName,
        resolver: resolve,
      };
      context.timer = setTimeout(() => {
        void this.completeSoftPause(key, 'timeout');
      }, timeoutMs);
      this.softPauseContexts.set(key, context);
      this.notifyRuntimeState(key);
    });
  }

  async resolveSoftPauseDecision(
    windowId: number | undefined,
    decision: 'continue_now' | 'pause'
  ): Promise<void> {
    const key = this.runtimeKey(windowId);
    const context = this.softPauseContexts.get(key);
    if (!context?.active) return;
    await this.completeSoftPause(key, decision);
  }

  private async completeSoftPause(runtimeKey: string, decision: 'timeout' | 'continue_now' | 'pause'): Promise<void> {
    const context = this.softPauseContexts.get(runtimeKey);
    if (!context?.active) return;

    if (context.timer) {
      clearTimeout(context.timer);
    }

    const resolvedAt = Date.now();
    const durationMs = Math.max(0, resolvedAt - context.startedAt);
    const binding = this.bindings.get(runtimeKey);
    const windowId = binding?.windowId;

    if (decision === 'pause') {
      await this.setExecutionState(windowId, 'paused_by_user', 'soft_pause_user_pause', 'user');
      await this.transitionAuthority(windowId, 'human_control', 'soft_pause_user_pause');
      context.resolver?.({ allowed: false, reason: 'Paused during soft deliberation window' });
    } else {
      await this.setExecutionState(windowId, 'running', `soft_pause_${decision}`, 'system');
      context.resolver?.({ allowed: true });
    }

    await this.logTelemetry('state_transition', {
      kind: 'soft_pause_resolved',
      timestamp: resolvedAt,
      decision,
      durationMs,
      timeoutMs: context.timeoutMs,
      stepId: context.stepId,
      toolName: context.toolName,
    });

    this.softPauseContexts.delete(runtimeKey);
    this.notifyRuntimeState(runtimeKey);
  }

  async registerStepCommitted(windowId: number | undefined): Promise<void> {
    const key = this.runtimeKey(windowId);
    const config = this.structuralAmplificationConfig.get(key);
    if (!config?.enabled) return;
    const events = this.amplificationManager.registerStepCommitted(key, this.normalizeAmplificationConfig(config), Date.now());
    if (events.length > 0) {
      await this.handleAmplificationEvents(key, events);
    }
  }

  async exitAmplifiedMode(
    windowId: number | undefined,
    _reason: 'explicit_exit' | 'task_boundary' = 'explicit_exit'
  ): Promise<void> {
    const key = this.runtimeKey(windowId);
    const events = this.amplificationManager.explicitExit(key, Date.now());
    if (events.length > 0) {
      await this.handleAmplificationEvents(key, events);
    }
  }

  classifyAmplifiedRisk(args: {
    windowId: number | undefined;
    toolName: string;
    toolInput: string;
  }): {
    effect_type: 'reversible' | 'irreversible';
    scope: 'local' | 'external';
    data_flow: 'disclosure' | 'none';
  } | null {
    const key = this.runtimeKey(args.windowId);
    const amplification = this.amplificationManager.getState(key);
    if (amplification.state !== 'amplified') return null;

    const name = args.toolName.toLowerCase();
    const input = args.toolInput.toLowerCase();
    const text = `${name} ${input}`;
    const hasSubmitVerb = /\b(submit|send|pay)\b/.test(text);
    const isClipboardExternal = text.includes('clipboard') && /\b(http|www|external|share)\b/.test(text);
    const permissionPopupDetected = /\b(permission|allow|grant)\b/.test(text);

    let changedOrigin = false;
    const urlMatch = args.toolInput.match(/https?:\/\/[^\s'"]+/i);
    if (urlMatch) {
      try {
        const parsed = new URL(urlMatch[0]);
        const navCtx = this.navigationContexts.get(key) ?? {};
        changedOrigin = Boolean(navCtx.lastOrigin && navCtx.lastOrigin !== parsed.origin);
        navCtx.lastOrigin = parsed.origin;
        this.navigationContexts.set(key, navCtx);
      } catch {
        // Ignore invalid URL fragments.
      }
    }

    if (!hasSubmitVerb && !isClipboardExternal && !permissionPopupDetected && !changedOrigin) {
      return null;
    }

    return {
      effect_type: hasSubmitVerb || permissionPopupDetected ? 'irreversible' : 'reversible',
      scope: changedOrigin || hasSubmitVerb || isClipboardExternal ? 'external' : 'local',
      data_flow: hasSubmitVerb || isClipboardExternal ? 'disclosure' : 'none',
    };
  }

  async pauseByUser(windowId: number | undefined): Promise<void> {
    const key = this.runtimeKey(windowId);
    if (this.softPauseContexts.get(key)?.active) {
      await this.resolveSoftPauseDecision(windowId, 'pause');
      return;
    }
    await this.setExecutionState(windowId, 'paused_by_user', 'user_pause', 'user');
    await this.transitionAuthority(windowId, 'human_control', 'user_pause');
    await this.logTelemetry('human_intervention', { kind: 'execution_paused', by: 'user', timestamp: Date.now() });
    await this.handleBehavioralSignal({ windowId, signal: 'pause_by_user', source: 'runtime' });
  }

  async pauseForRejectedAction(
    windowId: number | undefined,
    reason:
      | 'approval_rejected'
      | 'plan_step_rejected'
      | 'post_action_review_rejected'
      | 'action_dismissed'
  ): Promise<void> {
    const key = this.runtimeKey(windowId);
    const previous = this.authorityManager.getContext(key).authorityState;
    if (this.softPauseContexts.get(key)?.active) {
      await this.resolveSoftPauseDecision(windowId, 'pause');
      return;
    }

    await this.setExecutionState(windowId, 'paused_by_user', reason, 'user');
    await this.transitionAuthority(windowId, 'human_control', reason);
    await this.logTelemetry('human_intervention', {
      kind: 'authority_takeover',
      previous,
      timestamp: Date.now(),
      reason,
    });
    await this.handleBehavioralSignal({ windowId, signal: 'takeover', source: 'runtime' });
  }

  async resumeByUser(windowId: number | undefined): Promise<void> {
    const key = this.runtimeKey(windowId);
    if (this.softPauseContexts.get(key)?.active) {
      await this.resolveSoftPauseDecision(windowId, 'continue_now');
      await this.handleBehavioralSignal({ windowId, signal: 'resume_by_user', source: 'runtime' });
      return;
    }
    await this.setExecutionState(windowId, 'running', 'user_resume', 'user');
    await this.transitionAuthority(windowId, 'shared_supervision', 'user_resume');
    await this.logTelemetry('human_intervention', { kind: 'execution_resumed', by: 'user', timestamp: Date.now() });
    await this.handleBehavioralSignal({ windowId, signal: 'resume_by_user', source: 'runtime' });
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
    await this.handleBehavioralSignal({ windowId, signal: 'takeover', source: 'runtime' });
  }

  async releaseControl(windowId: number | undefined): Promise<void> {
    await this.transitionAuthority(windowId, 'agent_autonomous', 'user_release_control');
    await this.setExecutionState(windowId, 'running', 'user_release_control', 'user');
  }

  async resolveEscalation(windowId: number | undefined): Promise<void> {
    const key = this.runtimeKey(windowId);
    await this.transitionAuthority(windowId, 'agent_autonomous', 'escalation_resolved');

    const forcedTransition = this.regimeManager.forceBaseline(key, Date.now());
    if (forcedTransition) {
      await this.emitBehavioralEvent(key, forcedTransition, 'state_transition');
      const resolvedEvents = this.deliberationManager.resolveForManualExit(key, forcedTransition.timestamp);
      for (const event of resolvedEvents) {
        await this.emitBehavioralEvent(key, event, 'oversight_signal');
      }
      this.applyRuntimePolicy(key);
      this.notifyRuntimeState(key);
    }
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
    this.stopRegimeResolutionMonitor(key);
    this.clearIntentRefreshTimer(key);
    this.clearSoftPause(key);
    this.authorityManager.clear(key);
    this.phaseManager.clear(key);
    this.executionStateManager.clear(key);
    this.amplificationManager.clear(key);
    this.deliberationManager.clear(key);
    this.regimeManager.clear(key);
    this.regimePolicyAdapter.clear(key);
    this.navigationContexts.delete(key);
    this.structuralAmplificationConfig.delete(key);
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
