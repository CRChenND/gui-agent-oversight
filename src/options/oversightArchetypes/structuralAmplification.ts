import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  STRUCTURAL_AMPLIFICATION_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
} from '../../oversight/registry';
import { createArchetypeBase, defineArchetype } from './shared';

const { settings, parameterSettings } = createArchetypeBase();

settings[AGENT_FOCUS_MECHANISM_ID] = true;
settings[TASK_GRAPH_MECHANISM_ID] = true;
settings[MONITORING_MECHANISM_ID] = true;
settings[INTERVENTION_GATE_MECHANISM_ID] = true;
settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;
settings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID] = true;

parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'step';
parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'detailed';
parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'semantic';
parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'standard';
parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'summary';
parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = true;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'impact';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'risky_only';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';
parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].enableStructuralAmplification = true;
parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].deliberationThreshold = 3;
parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].signalDecayMs = 10000;
parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].sustainedWindowMs = 10000;
parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID].resolutionWindowMs = 15000;

export const structuralAmplificationArchetype = defineArchetype({
  id: 'structural-amplification',
  name: 'Structural Amplification',
  description: 'The page shows what the agent is focusing on and thinking, and oversight gets stronger when you pause or inspect more closely.',
  authorityModel: 'Baseline delegation with user-driven escalation into tighter oversight.',
  visibilityStructure: 'Context-sensitive expansion from selective exposure to richer trace and rationale scaffolds.',
  oversightRhythm: 'Adaptive amplification triggered by repeated inspection or pause behavior.',
  settings,
  parameterSettings,
});
