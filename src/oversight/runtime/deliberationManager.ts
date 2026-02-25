import type { DeliberationState } from './types';

export type BehavioralSignalType =
  | 'pause_by_user'
  | 'takeover'
  | 'expand_trace_node'
  | 'hover_risk_label'
  | 'open_oversight_tab'
  | 'edit_intermediate_output'
  | 'repeated_scroll_backward'
  | 'repeated_trace_expansion';

export interface DeliberationConfig {
  enabled: boolean;
  deliberationThreshold: number;
  signalDecayMs: number;
  sustainedWindowMs: number;
}

interface DeliberationContext {
  state: DeliberationState;
  signalTimestamps: number[];
  enteredAt?: number;
}

export type DeliberationEvent =
  | {
      kind: 'deliberation_score_updated';
      score: number;
      lastSignalTimestamp: number;
      sustainedDurationMs: number;
      isDeliberative: boolean;
      signal: BehavioralSignalType;
      timestamp: number;
    }
  | {
      kind: 'deliberation_entered';
      score: number;
      sustainedDurationMs: number;
      signal: BehavioralSignalType;
      timestamp: number;
    }
  | {
      kind: 'deliberation_resolved';
      score: number;
      reason: 'disabled' | 'inactivity' | 'manual_exit';
      timestamp: number;
    };

const EMPTY_STATE: DeliberationState = {
  score: 0,
  lastSignalTimestamp: 0,
  sustainedDurationMs: 0,
  isDeliberative: false,
};

export class DeliberationManager {
  private contexts = new Map<string, DeliberationContext>();

  initialize(runtimeKey: string): void {
    this.contexts.set(runtimeKey, {
      state: { ...EMPTY_STATE },
      signalTimestamps: [],
    });
  }

  getState(runtimeKey: string): DeliberationState {
    return this.contexts.get(runtimeKey)?.state ?? { ...EMPTY_STATE };
  }

  registerSignal(
    runtimeKey: string,
    signal: BehavioralSignalType,
    config: DeliberationConfig,
    timestamp = Date.now()
  ): { state: DeliberationState; events: DeliberationEvent[] } {
    const context = this.getOrCreateContext(runtimeKey);
    const events: DeliberationEvent[] = [];

    if (!config.enabled) {
      const wasDeliberative = context.state.isDeliberative;
      context.state = { ...EMPTY_STATE };
      context.signalTimestamps = [];
      context.enteredAt = undefined;
      if (wasDeliberative) {
        events.push({
          kind: 'deliberation_resolved',
          score: 0,
          reason: 'disabled',
          timestamp,
        });
      }
      return { state: { ...context.state }, events };
    }

    const previous = context.state;
    const decayedScore = this.applyScoreDecay(previous.score, previous.lastSignalTimestamp, timestamp, config.signalDecayMs);
    const nextScore = Math.max(0, decayedScore + 1);

    const retainedSignals = context.signalTimestamps.filter((ts) => timestamp - ts <= config.sustainedWindowMs);
    retainedSignals.push(timestamp);
    context.signalTimestamps = retainedSignals;

    const threshold = Math.max(1, config.deliberationThreshold);
    const isDeliberative = retainedSignals.length >= threshold;
    const sustainedDurationMs =
      isDeliberative && retainedSignals.length > 0 ? Math.max(0, timestamp - retainedSignals[0]) : 0;

    context.state = {
      score: nextScore,
      lastSignalTimestamp: timestamp,
      sustainedDurationMs,
      isDeliberative,
    };

    events.push({
      kind: 'deliberation_score_updated',
      score: context.state.score,
      lastSignalTimestamp: context.state.lastSignalTimestamp,
      sustainedDurationMs: context.state.sustainedDurationMs,
      isDeliberative: context.state.isDeliberative,
      signal,
      timestamp,
    });

    if (!previous.isDeliberative && context.state.isDeliberative) {
      context.enteredAt = timestamp;
      events.push({
        kind: 'deliberation_entered',
        score: context.state.score,
        sustainedDurationMs: context.state.sustainedDurationMs,
        signal,
        timestamp,
      });
    }

    return { state: { ...context.state }, events };
  }

  resolveForInactivity(runtimeKey: string, timestamp = Date.now()): DeliberationEvent[] {
    return this.resolve(runtimeKey, 'inactivity', timestamp, false);
  }

  resolveForManualExit(runtimeKey: string, timestamp = Date.now()): DeliberationEvent[] {
    return this.resolve(runtimeKey, 'manual_exit', timestamp, true);
  }

  private resolve(
    runtimeKey: string,
    reason: 'inactivity' | 'manual_exit',
    timestamp: number,
    resetScore: boolean
  ): DeliberationEvent[] {
    const context = this.contexts.get(runtimeKey);
    if (!context || !context.state.isDeliberative) return [];

    context.state = {
      ...context.state,
      score: resetScore ? 0 : context.state.score,
      isDeliberative: false,
      sustainedDurationMs: 0,
    };
    context.signalTimestamps = [];
    context.enteredAt = undefined;

    return [
      {
        kind: 'deliberation_resolved',
        score: context.state.score,
        reason,
        timestamp,
      },
    ];
  }

  clear(runtimeKey: string): void {
    this.contexts.delete(runtimeKey);
  }

  private getOrCreateContext(runtimeKey: string): DeliberationContext {
    const existing = this.contexts.get(runtimeKey);
    if (existing) return existing;
    const created: DeliberationContext = {
      state: { ...EMPTY_STATE },
      signalTimestamps: [],
    };
    this.contexts.set(runtimeKey, created);
    return created;
  }

  private applyScoreDecay(score: number, previousTimestamp: number, now: number, signalDecayMs: number): number {
    if (score <= 0 || previousTimestamp <= 0) return Math.max(0, score);
    const decayMs = Math.max(1, signalDecayMs);
    const elapsedMs = Math.max(0, now - previousTimestamp);
    const decayUnits = elapsedMs / decayMs;
    return Math.max(0, score - decayUnits);
  }
}
