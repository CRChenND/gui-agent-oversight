export type OversightProfileId = 'observe_only' | 'stepwise' | 'impact_gated' | 'adaptive';

export interface OversightProfile {
  id: OversightProfileId;
  title: string;
  enabledMechanisms: string[];
  parameterOverrides?: Record<string, any>;
}
