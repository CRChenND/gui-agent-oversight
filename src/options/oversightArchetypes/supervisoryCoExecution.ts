import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
} from '../../oversight/registry';
import { createArchetypeBase, defineArchetype } from './shared';

const { settings, parameterSettings } = createArchetypeBase();

settings[AGENT_FOCUS_MECHANISM_ID] = true;
settings[TASK_GRAPH_MECHANISM_ID] = true;
settings[MONITORING_MECHANISM_ID] = true;
settings[INTERVENTION_GATE_MECHANISM_ID] = true;
settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = true;

parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'substep';
parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'detailed';
parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'high_contrast';
parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'full';
parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'full';
parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'snippet';
parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 300000;
parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = true;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'adaptive';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'step_through';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'extended';

export const supervisoryCoExecutionArchetype = defineArchetype({
  id: 'supervisory-co-execution',
  name: 'Supervisory Co-Execution',
  description: 'Shared-control workspace with continuous visibility into execution traces.',
  authorityModel: 'Shared control during execution with collaborative steering.',
  visibilityStructure: 'Continuous plan and trace visibility in a persistent workspace.',
  oversightRhythm: 'Continuous monitoring with optional intervention at any step.',
  settings,
  parameterSettings,
});
