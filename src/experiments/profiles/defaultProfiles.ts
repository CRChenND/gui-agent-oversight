import type { OversightProfile } from './types';

export const DEFAULT_PROFILES: OversightProfile[] = [
  {
    id: 'observe_only',
    title: 'Observe Only',
    enabledMechanisms: ['monitoring'],
    parameterOverrides: {
      gatePolicy: 'never',
    },
  },
  {
    id: 'stepwise',
    title: 'Stepwise Approval',
    enabledMechanisms: ['monitoring', 'interventionGate'],
    parameterOverrides: {
      gatePolicy: 'always',
    },
  },
  {
    id: 'impact_gated',
    title: 'Impact-Gated',
    enabledMechanisms: ['monitoring', 'interventionGate'],
    parameterOverrides: {
      gatePolicy: 'impact',
    },
  },
  {
    id: 'adaptive',
    title: 'Adaptive Oversight',
    enabledMechanisms: ['monitoring', 'interventionGate', 'adaptiveController'],
    parameterOverrides: {
      gatePolicy: 'adaptive',
    },
  },
];
