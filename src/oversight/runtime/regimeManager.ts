import type { DeliberationState, OversightRegime } from './types';

interface RegimeContext {
  regime: OversightRegime;
  updatedAt: number;
  enteredAt?: number;
}

export interface RegimeConfig {
  enabled: boolean;
  resolutionWindowMs: number;
}

export interface RegimeTransitionEvent {
  kind: 'regime_transition';
  from: OversightRegime;
  to: OversightRegime;
  trigger: 'behavioral';
  timestamp: number;
}

export class RegimeManager {
  private contexts = new Map<string, RegimeContext>();

  initialize(runtimeKey: string): void {
    this.contexts.set(runtimeKey, {
      regime: 'baseline',
      updatedAt: Date.now(),
    });
  }

  getRegime(runtimeKey: string): OversightRegime {
    return this.contexts.get(runtimeKey)?.regime ?? 'baseline';
  }

  getEnteredAt(runtimeKey: string): number | undefined {
    return this.contexts.get(runtimeKey)?.enteredAt;
  }

  update(
    runtimeKey: string,
    deliberationState: DeliberationState,
    config: RegimeConfig,
    timestamp = Date.now()
  ): RegimeTransitionEvent | null {
    const context = this.getOrCreate(runtimeKey);
    const from = context.regime;

    if (!config.enabled) {
      if (from === 'deliberative_escalated') {
        context.regime = 'baseline';
        context.updatedAt = timestamp;
        context.enteredAt = undefined;
        return {
          kind: 'regime_transition',
          from,
          to: 'baseline',
          trigger: 'behavioral',
          timestamp,
        };
      }
      return null;
    }

    if (from === 'baseline' && deliberationState.isDeliberative) {
      context.regime = 'deliberative_escalated';
      context.updatedAt = timestamp;
      context.enteredAt = timestamp;
      return {
        kind: 'regime_transition',
        from,
        to: context.regime,
        trigger: 'behavioral',
        timestamp,
      };
    }

    if (from === 'deliberative_escalated') {
      const resolutionWindowMs = Math.max(0, config.resolutionWindowMs);
      const lastSignalAt = deliberationState.lastSignalTimestamp;
      const shouldResolve = !lastSignalAt || timestamp - lastSignalAt >= resolutionWindowMs;
      if (shouldResolve) {
        context.regime = 'baseline';
        context.updatedAt = timestamp;
        context.enteredAt = undefined;
        return {
          kind: 'regime_transition',
          from,
          to: 'baseline',
          trigger: 'behavioral',
          timestamp,
        };
      }
    }

    context.updatedAt = timestamp;
    return null;
  }

  clear(runtimeKey: string): void {
    this.contexts.delete(runtimeKey);
  }

  forceBaseline(runtimeKey: string, timestamp = Date.now()): RegimeTransitionEvent | null {
    const context = this.getOrCreate(runtimeKey);
    if (context.regime !== 'deliberative_escalated') return null;
    const from = context.regime;
    context.regime = 'baseline';
    context.updatedAt = timestamp;
    context.enteredAt = undefined;
    return {
      kind: 'regime_transition',
      from,
      to: 'baseline',
      trigger: 'behavioral',
      timestamp,
    };
  }

  private getOrCreate(runtimeKey: string): RegimeContext {
    const existing = this.contexts.get(runtimeKey);
    if (existing) return existing;
    const created: RegimeContext = { regime: 'baseline', updatedAt: Date.now() };
    this.contexts.set(runtimeKey, created);
    return created;
  }
}
