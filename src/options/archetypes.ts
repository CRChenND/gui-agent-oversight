import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  STRUCTURAL_AMPLIFICATION_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  createDefaultOversightMechanismSettings,
  createDefaultOversightParameterSettings,
  type OversightMechanismParameterSettings,
  type OversightMechanismSettings,
} from '../oversight/registry';

export const OVERSIGHT_ARCHETYPES_STORAGE_KEY = 'oversight.interaction.archetypes';

export type ArchetypeScope = 'builtin' | 'custom';

export interface OversightArchetype {
  id: string;
  name: string;
  description: string;
  scope: ArchetypeScope;
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
}

export interface StoredOversightArchetype {
  id: string;
  name: string;
  description?: string;
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
}

function baseArchetypeState(): {
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
} {
  return {
    settings: createDefaultOversightMechanismSettings(),
    parameterSettings: createDefaultOversightParameterSettings(),
  };
}

export function getBuiltinArchetypes(): OversightArchetype[] {
  const riskGated = baseArchetypeState();
  riskGated.settings[AGENT_FOCUS_MECHANISM_ID] = true;
  riskGated.settings[TASK_GRAPH_MECHANISM_ID] = true;
  riskGated.settings[MONITORING_MECHANISM_ID] = true;
  riskGated.settings[INTERVENTION_GATE_MECHANISM_ID] = true;
  riskGated.settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;
  riskGated.parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'step';
  riskGated.parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'balanced';
  riskGated.parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'semantic';
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'standard';
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'summary';
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
  riskGated.parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = false;
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'impact';
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'risky_only';
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
  riskGated.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';

  const supervisory = baseArchetypeState();
  supervisory.settings[AGENT_FOCUS_MECHANISM_ID] = true;
  supervisory.settings[TASK_GRAPH_MECHANISM_ID] = true;
  supervisory.settings[MONITORING_MECHANISM_ID] = true;
  supervisory.settings[INTERVENTION_GATE_MECHANISM_ID] = true;
  supervisory.settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = true;
  supervisory.parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'substep';
  supervisory.parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'detailed';
  supervisory.parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'high_contrast';
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'full';
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'full';
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'snippet';
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 300000;
  supervisory.parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = true;
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'adaptive';
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'step_through';
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
  supervisory.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'extended';

  const actionConfirmation = baseArchetypeState();
  actionConfirmation.settings[AGENT_FOCUS_MECHANISM_ID] = false;
  actionConfirmation.settings[TASK_GRAPH_MECHANISM_ID] = false;
  actionConfirmation.settings[MONITORING_MECHANISM_ID] = true;
  actionConfirmation.settings[INTERVENTION_GATE_MECHANISM_ID] = true;
  actionConfirmation.settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'minimal';
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'none';
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'modal';
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
  actionConfirmation.parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = false;
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'always';
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'step_through';
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
  actionConfirmation.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';

  const structuralAmplification = baseArchetypeState();
  structuralAmplification.settings[AGENT_FOCUS_MECHANISM_ID] = true;
  structuralAmplification.settings[TASK_GRAPH_MECHANISM_ID] = true;
  structuralAmplification.settings[MONITORING_MECHANISM_ID] = true;
  structuralAmplification.settings[INTERVENTION_GATE_MECHANISM_ID] = true;
  structuralAmplification.settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;
  structuralAmplification.settings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID] = true;
  structuralAmplification.parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'step';
  structuralAmplification.parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'detailed';
  structuralAmplification.parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'semantic';
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'standard';
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'summary';
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
  structuralAmplification.parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = true;
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'impact';
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'risky_only';
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
  structuralAmplification.parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';
  structuralAmplification.parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].enableStructuralAmplification = true;
  structuralAmplification.parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].deliberationThreshold = 3;
  structuralAmplification.parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].signalDecayMs = 10000;
  structuralAmplification.parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].sustainedWindowMs = 10000;
  structuralAmplification.parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].resolutionWindowMs = 15000;

  return [
    {
      id: 'builtin-risk-gated',
      name: 'Risk-Gated Oversight',
      description: 'Autonomous by default; explicit approval only for risky steps.',
      scope: 'builtin',
      settings: riskGated.settings,
      parameterSettings: riskGated.parameterSettings,
    },
    {
      id: 'builtin-supervisory',
      name: 'Supervisory Co-Execution',
      description: 'Persistent trace visibility with adaptive, collaborative intervention.',
      scope: 'builtin',
      settings: supervisory.settings,
      parameterSettings: supervisory.parameterSettings,
    },
    {
      id: 'builtin-action-confirmation',
      name: 'Action-Confirmation Oversight',
      description: 'Human veto at each action boundary with minimal disclosure.',
      scope: 'builtin',
      settings: actionConfirmation.settings,
      parameterSettings: actionConfirmation.parameterSettings,
    },
    {
      id: 'builtin-structural-amplification',
      name: 'Structural Amplification Oversight',
      description: 'Risk-gated baseline with behavior-driven deliberative escalation.',
      scope: 'builtin',
      settings: structuralAmplification.settings,
      parameterSettings: structuralAmplification.parameterSettings,
    },
  ];
}

export function toStoredArchetype(archetype: OversightArchetype): StoredOversightArchetype {
  return {
    id: archetype.id,
    name: archetype.name,
    description: archetype.description,
    settings: archetype.settings,
    parameterSettings: archetype.parameterSettings,
  };
}

export function hydrateCustomArchetypes(input: unknown): OversightArchetype[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as Partial<StoredOversightArchetype>)
    .filter(
      (item) =>
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        item.settings &&
        typeof item.settings === 'object' &&
        item.parameterSettings &&
        typeof item.parameterSettings === 'object'
    )
    .map((item) => ({
      id: item.id as string,
      name: item.name as string,
      description: typeof item.description === 'string' ? item.description : 'Custom archetype preset.',
      scope: 'custom' as const,
      settings: item.settings as OversightMechanismSettings,
      parameterSettings: item.parameterSettings as OversightMechanismParameterSettings,
    }));
}
