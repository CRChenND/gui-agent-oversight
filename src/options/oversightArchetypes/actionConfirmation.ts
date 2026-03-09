import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
} from '../../oversight/registry';
import { createArchetypeBase, defineArchetype } from './shared';

const { settings, parameterSettings } = createArchetypeBase();

settings[AGENT_FOCUS_MECHANISM_ID] = false;
settings[TASK_GRAPH_MECHANISM_ID] = false;
settings[MONITORING_MECHANISM_ID] = true;
settings[INTERVENTION_GATE_MECHANISM_ID] = true;
settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;

parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'minimal';
parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'none';
parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'modal';
parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = false;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'always';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'step_through';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';

export const actionConfirmationArchetype = defineArchetype({
  id: 'action-confirmation',
  name: 'Action-Confirmation Oversight',
  description: 'The agent explains each next action in the chat, and you must agree before it does anything.',
  authorityModel: 'Human must approve every action before execution.',
  visibilityStructure: 'Minimal intent summary per action rather than persistent trace exposure.',
  oversightRhythm: 'Mandatory per-action confirmation without automated risk classification.',
  settings,
  parameterSettings,
});
