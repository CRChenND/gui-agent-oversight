import type { OversightRegime, RuntimePolicyState } from './types';

export interface RuntimePolicyAdapterConfig {
  escalationPersistenceMs: number;
}

export class RegimePolicyAdapter {
  private baselinePolicy = new Map<string, RuntimePolicyState>();
  private effectivePolicy = new Map<string, RuntimePolicyState>();

  initialize(runtimeKey: string, baselinePolicy: RuntimePolicyState): void {
    const normalized: RuntimePolicyState = {
      monitoringContentScope: baselinePolicy.monitoringContentScope,
      explanationAvailability: baselinePolicy.explanationAvailability,
      userActionOptions: baselinePolicy.userActionOptions,
      persistenceMs: Math.max(0, baselinePolicy.persistenceMs),
      tightenHighImpactAuthority: Boolean(baselinePolicy.tightenHighImpactAuthority),
    };
    this.baselinePolicy.set(runtimeKey, normalized);
    this.effectivePolicy.set(runtimeKey, normalized);
  }

  apply(runtimeKey: string, regime: OversightRegime, config: RuntimePolicyAdapterConfig): RuntimePolicyState {
    const baseline = this.baselinePolicy.get(runtimeKey) ?? {
      monitoringContentScope: 'standard',
      explanationAvailability: 'summary',
      userActionOptions: 'basic',
      persistenceMs: 0,
      tightenHighImpactAuthority: false,
    };

    if (regime === 'deliberative_escalated') {
      const escalated: RuntimePolicyState = {
        monitoringContentScope: 'full',
        explanationAvailability: 'full',
        userActionOptions: 'extended',
        persistenceMs: Math.max(baseline.persistenceMs, Math.max(0, config.escalationPersistenceMs)),
        tightenHighImpactAuthority: true,
      };
      this.effectivePolicy.set(runtimeKey, escalated);
      return escalated;
    }

    this.effectivePolicy.set(runtimeKey, baseline);
    return baseline;
  }

  getEffectivePolicy(runtimeKey: string): RuntimePolicyState {
    return this.effectivePolicy.get(runtimeKey) ?? {
      monitoringContentScope: 'standard',
      explanationAvailability: 'summary',
      userActionOptions: 'basic',
      persistenceMs: 0,
      tightenHighImpactAuthority: false,
    };
  }

  clear(runtimeKey: string): void {
    this.baselinePolicy.delete(runtimeKey);
    this.effectivePolicy.delete(runtimeKey);
  }
}
