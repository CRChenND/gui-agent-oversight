import type { AmplificationEnterReason, AmplificationState } from './types';

export type AmplificationSignal =
  | 'pause_by_user'
  | 'resume_by_user'
  | 'inspect_plan'
  | 'expand_trace_node'
  | 'repeated_trace_expansion'
  | 'open_oversight_tab'
  | 'hover_risk_label';

export interface AmplificationConfig {
  enabled: boolean;
  rapidPauseResumeWindowMs: number;
  traceExpansionWindowMs: number;
  inactivityExitSteps: number;
  intentRefreshEverySteps: number;
}

interface AmplificationContext {
  state: AmplificationState;
  enteredAt?: number;
  enteredReason?: AmplificationEnterReason;
  entryCount: number;
  lastPauseAt?: number;
  traceExpansionTimestamps: number[];
  sawInspectionThisStep: boolean;
  stepsWithoutInspection: number;
  stepCountInAmplified: number;
}

export type AmplificationEvent =
  | {
      kind: 'amplification_entered';
      from: AmplificationState;
      to: 'amplified';
      reason: AmplificationEnterReason;
      timestamp: number;
    }
  | {
      kind: 'amplification_exited';
      from: 'amplified';
      to: 'normal';
      reason: 'inactivity' | 'explicit_exit' | 'task_boundary';
      timestamp: number;
    }
  | {
      kind: 'intent_refresh_triggered';
      timestamp: number;
      stepCountInAmplified: number;
    };

const EMPTY_CONTEXT: AmplificationContext = {
  state: 'normal',
  entryCount: 0,
  traceExpansionTimestamps: [],
  sawInspectionThisStep: false,
  stepsWithoutInspection: 0,
  stepCountInAmplified: 0,
};

export class AmplificationManager {
  private contexts = new Map<string, AmplificationContext>();

  initialize(runtimeKey: string): void {
    this.contexts.set(runtimeKey, {
      ...EMPTY_CONTEXT,
      traceExpansionTimestamps: [],
    });
  }

  getState(runtimeKey: string): AmplificationContext {
    const context = this.contexts.get(runtimeKey);
    if (context) {
      return {
        ...context,
        traceExpansionTimestamps: [...context.traceExpansionTimestamps],
      };
    }
    return { ...EMPTY_CONTEXT };
  }

  registerSignal(
    runtimeKey: string,
    signal: AmplificationSignal,
    config: AmplificationConfig,
    timestamp = Date.now()
  ): AmplificationEvent[] {
    const context = this.getOrCreateContext(runtimeKey);
    const events: AmplificationEvent[] = [];
    if (!config.enabled) return events;

    if (signal === 'pause_by_user') {
      context.lastPauseAt = timestamp;
      return events;
    }

    if (signal === 'resume_by_user') {
      const lastPauseAt = context.lastPauseAt ?? 0;
      if (lastPauseAt > 0 && timestamp - lastPauseAt <= Math.max(1, config.rapidPauseResumeWindowMs)) {
        const entered = this.enter(context, 'pause_resume_rapid', timestamp);
        if (entered) events.push(entered);
      }
      return events;
    }

    if (signal === 'inspect_plan') {
      context.sawInspectionThisStep = true;
      const entered = this.enter(context, 'inspect_plan', timestamp);
      if (entered) events.push(entered);
      return events;
    }

    if (signal === 'expand_trace_node' || signal === 'repeated_trace_expansion') {
      context.sawInspectionThisStep = true;
      const retained = context.traceExpansionTimestamps.filter(
        (ts) => timestamp - ts <= Math.max(1, config.traceExpansionWindowMs)
      );
      retained.push(timestamp);
      context.traceExpansionTimestamps = retained;
      if (retained.length >= 2) {
        const entered = this.enter(context, 'rapid_trace_inspection', timestamp);
        if (entered) events.push(entered);
      }
      return events;
    }

    if (signal === 'open_oversight_tab' || signal === 'hover_risk_label') {
      context.sawInspectionThisStep = true;
    }

    return events;
  }

  registerStepCommitted(runtimeKey: string, config: AmplificationConfig, timestamp = Date.now()): AmplificationEvent[] {
    const context = this.contexts.get(runtimeKey);
    if (!context || context.state !== 'amplified' || !config.enabled) return [];

    context.stepCountInAmplified += 1;
    if (context.sawInspectionThisStep) {
      context.stepsWithoutInspection = 0;
    } else {
      context.stepsWithoutInspection += 1;
    }
    context.sawInspectionThisStep = false;

    if (context.stepsWithoutInspection >= Math.max(1, config.inactivityExitSteps)) {
      return [this.exit(context, 'inactivity', timestamp)];
    }

    if (
      context.stepCountInAmplified > 0 &&
      context.stepCountInAmplified % Math.max(1, config.intentRefreshEverySteps) === 0
    ) {
      return [
        {
          kind: 'intent_refresh_triggered',
          timestamp,
          stepCountInAmplified: context.stepCountInAmplified,
        },
      ];
    }

    return [];
  }

  explicitExit(runtimeKey: string, timestamp = Date.now()): AmplificationEvent[] {
    const context = this.contexts.get(runtimeKey);
    if (!context || context.state !== 'amplified') return [];
    return [this.exit(context, 'explicit_exit', timestamp)];
  }

  exitForTaskBoundary(runtimeKey: string, timestamp = Date.now()): AmplificationEvent[] {
    const context = this.contexts.get(runtimeKey);
    if (!context || context.state !== 'amplified') return [];
    return [this.exit(context, 'task_boundary', timestamp)];
  }

  clear(runtimeKey: string): void {
    this.contexts.delete(runtimeKey);
  }

  private getOrCreateContext(runtimeKey: string): AmplificationContext {
    const existing = this.contexts.get(runtimeKey);
    if (existing) return existing;
    const created: AmplificationContext = {
      ...EMPTY_CONTEXT,
      traceExpansionTimestamps: [],
    };
    this.contexts.set(runtimeKey, created);
    return created;
  }

  private enter(
    context: AmplificationContext,
    reason: AmplificationEnterReason,
    timestamp: number
  ): AmplificationEvent | null {
    if (context.state === 'amplified') return null;
    const from = context.state;
    context.state = 'amplified';
    context.enteredAt = timestamp;
    context.enteredReason = reason;
    context.entryCount += 1;
    context.stepsWithoutInspection = 0;
    context.stepCountInAmplified = 0;
    context.sawInspectionThisStep = true;
    return {
      kind: 'amplification_entered',
      from,
      to: 'amplified',
      reason,
      timestamp,
    };
  }

  private exit(
    context: AmplificationContext,
    reason: 'inactivity' | 'explicit_exit' | 'task_boundary',
    timestamp: number
  ): AmplificationEvent {
    context.state = 'normal';
    context.enteredAt = undefined;
    context.enteredReason = undefined;
    context.traceExpansionTimestamps = [];
    context.stepsWithoutInspection = 0;
    context.stepCountInAmplified = 0;
    context.sawInspectionThisStep = false;
    return {
      kind: 'amplification_exited',
      from: 'amplified',
      to: 'normal',
      reason,
      timestamp,
    };
  }
}
