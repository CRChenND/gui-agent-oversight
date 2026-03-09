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
settings[TASK_GRAPH_MECHANISM_ID] = false;
settings[MONITORING_MECHANISM_ID] = true;
settings[INTERVENTION_GATE_MECHANISM_ID] = true;
settings[ADAPTIVE_CONTROLLER_MECHANISM_ID] = false;

parameterSettings[TASK_GRAPH_MECHANISM_ID].contentGranularity = 'step';
parameterSettings[TASK_GRAPH_MECHANISM_ID].informationDensity = 'balanced';
parameterSettings[TASK_GRAPH_MECHANISM_ID].colorEncoding = 'semantic';
parameterSettings[MONITORING_MECHANISM_ID].monitoringContentScope = 'standard';
parameterSettings[MONITORING_MECHANISM_ID].explanationAvailability = 'summary';
parameterSettings[MONITORING_MECHANISM_ID].explanationFormat = 'text';
parameterSettings[MONITORING_MECHANISM_ID].notificationModality = 'mixed';
parameterSettings[MONITORING_MECHANISM_ID].feedbackLatencyMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].persistenceMs = 0;
parameterSettings[MONITORING_MECHANISM_ID].showPostHocPanel = false;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = 'impact';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].controlMode = 'risky_only';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].timingPolicy = 'pre_action';
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptCooldownMs = 0;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].interruptTopK = 999;
parameterSettings[INTERVENTION_GATE_MECHANISM_ID].userActionOptions = 'basic';

export const riskGatedArchetype = defineArchetype({
  id: 'risk-gated',
  name: 'Risk-Gated Oversight',
  description: 'The agent usually runs on its own. You only step in when it reaches a higher-risk action.',
  authorityModel: 'Agent executes by default; human approves only high-risk actions.',
  visibilityStructure: 'Selective, risk-triggered exposure with concise summaries.',
  oversightRhythm: 'Episodic intervention concentrated at predicted high-risk moments.',
  settings,
  parameterSettings,
});
