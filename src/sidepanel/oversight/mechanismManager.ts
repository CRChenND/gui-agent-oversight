import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  getOversightParameterDefaultValue,
  type OversightMechanismId,
  type OversightMechanismParameterSettings,
  type OversightMechanismSettings,
  type OversightParameterValue,
} from '../../oversight/registry';
import type {
  AgentThinkingSummary,
  InterventionEvent,
  OversightEvent,
  OversightLevel,
  StepContextEvent,
  StepImpact,
} from '../../oversight/types';
import type { TaskNode, TaskNodeStatus } from '../components/TaskExecutionGraph';

export interface OversightConfig {
  enabledMechanisms: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
}

export interface AgentFocusState {
  state: 'active' | 'idle';
  toolName: string | null;
  focusLabel: string;
  updatedAt: number;
}

export interface AdaptiveOversightRuntimeState {
  currentLevel: OversightLevel;
  recentRiskEvents: number;
  consecutiveApprovals: number;
  lowRiskNoInterventionStreak: number;
}

export interface OversightUiState {
  taskGraph: {
    nodes: TaskNode[];
    expanded: boolean;
  };
  agentFocus: AgentFocusState;
  thinkingByStepId: Record<string, AgentThinkingSummary>;
  interventionGate: {
    openStepId: string | null;
    promptedStepIds: string[];
    decisions: Array<{ stepId: string; decision: 'approve' | 'deny' | 'edit' | 'rollback' }>;
  };
  adaptiveState: AdaptiveOversightRuntimeState;
  runtime: {
    authorityState: 'agent_autonomous' | 'shared_supervision' | 'human_control';
    executionPhase: 'planning' | 'plan_review' | 'execution' | 'posthoc_review' | 'terminated';
    executionState:
      | 'running'
      | 'paused_by_user'
      | 'paused_by_system'
      | 'paused_by_system_soft'
      | 'cancelled'
      | 'completed';
    updatedAt: number;
  };
}

interface OversightContextInput {
  getLatestThinking: () => string;
  emitTelemetry?: (event: InterventionEvent | OversightEvent) => void;
}

interface OversightContext extends OversightContextInput {
  getParameter: (mechanismId: OversightMechanismId, parameterKey: string) => OversightParameterValue | undefined;
}

interface OversightMechanism {
  id: OversightMechanismId;
  reduce: (state: OversightUiState, event: OversightEvent, ctx: OversightContext) => OversightUiState;
}

function markActiveNodes(nodes: TaskNode[], status: TaskNodeStatus): TaskNode[] {
  return nodes.map((node) => (node.status === 'active' ? { ...node, status } : node));
}

function getGatePolicy(ctx: OversightContext): 'never' | 'always' | 'impact' | 'adaptive' {
  const raw = ctx.getParameter(INTERVENTION_GATE_MECHANISM_ID, 'gatePolicy');
  return raw === 'never' || raw === 'always' || raw === 'impact' || raw === 'adaptive' ? raw : 'impact';
}

function shouldPromptAdaptive(level: OversightLevel, step: StepContextEvent): boolean {
  if (level === 'stepwise') return true;
  if (level === 'impact_gated') return step.impact === 'high';
  return false;
}

function shouldOpenGateForStep(state: OversightUiState, step: StepContextEvent, ctx: OversightContext): boolean {
  const policy = getGatePolicy(ctx);
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'impact') return step.impact === 'high';
  return shouldPromptAdaptive(state.adaptiveState.currentLevel, step);
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asImpact(value: unknown, fallback: StepImpact): StepImpact {
  return value === 'low' || value === 'medium' || value === 'high' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

type AmplifiedRiskTag = NonNullable<NonNullable<TaskNode['intervention']>['amplifiedRisk']>;

function asAmplifiedRiskTag(value: unknown): AmplifiedRiskTag | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const effect_type: AmplifiedRiskTag['effect_type'] =
    raw.effect_type === 'irreversible' ? 'irreversible' : 'reversible';
  const scope: AmplifiedRiskTag['scope'] = raw.scope === 'external' ? 'external' : 'local';
  const data_flow: AmplifiedRiskTag['data_flow'] = raw.data_flow === 'disclosure' ? 'disclosure' : 'none';
  return { effect_type, scope, data_flow };
}

function transitionOversightLevel(
  state: OversightUiState,
  to: OversightLevel,
  reason: string,
  ctx: OversightContext
): OversightUiState {
  if (state.adaptiveState.currentLevel === to) {
    return state;
  }

  const levelEvent: OversightEvent = {
    kind: 'oversight_level_changed',
    from: state.adaptiveState.currentLevel,
    to,
    reason,
    timestamp: Date.now(),
  };

  ctx.emitTelemetry?.(levelEvent);

  return {
    ...state,
    adaptiveState: {
      ...state.adaptiveState,
      currentLevel: to,
    },
  };
}

const taskGraphMechanism: OversightMechanism = {
  id: TASK_GRAPH_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    if (event.kind === 'tool_started') {
      const maxNodes = Math.max(1, Number(ctx.getParameter(TASK_GRAPH_MECHANISM_ID, 'maxNodes') ?? 20));
      const autoExpand = Boolean(ctx.getParameter(TASK_GRAPH_MECHANISM_ID, 'autoExpand') ?? true);

      const nextNodes = markActiveNodes(state.taskGraph.nodes, 'completed');
      nextNodes.push({
        id: event.stepId,
        stepId: event.stepId,
        toolName: event.toolName,
        focusLabel: event.focusLabel || 'Focus updated',
        thinking:
          state.thinkingByStepId[event.stepId]?.rationale ||
          state.thinkingByStepId[event.stepId]?.goal ||
          ctx.getLatestThinking(),
        status: 'active',
        timestamp: event.timestamp,
      });

      const cappedNodes = nextNodes.length > maxNodes ? nextNodes.slice(nextNodes.length - maxNodes) : nextNodes;

      return {
        ...state,
        taskGraph: {
          nodes: cappedNodes,
          expanded: autoExpand ? true : state.taskGraph.expanded,
        },
      };
    }

    if (event.kind === 'agent_thinking') {
      const nextNodes = state.taskGraph.nodes.map((node) => {
        if (node.stepId !== event.stepId) return node;
        return {
          ...node,
          thinking: event.thinking.rationale || event.thinking.goal,
        };
      });
      return {
        ...state,
        taskGraph: {
          ...state.taskGraph,
          nodes: nextNodes,
        },
        thinkingByStepId: {
          ...state.thinkingByStepId,
          [event.stepId]: event.thinking,
        },
      };
    }

    if (event.kind === 'run_completed') {
      return {
        ...state,
        taskGraph: {
          nodes: markActiveNodes(state.taskGraph.nodes, 'completed'),
          expanded: false,
        },
      };
    }

    if (event.kind === 'run_cancelled') {
      return {
        ...state,
        taskGraph: {
          nodes: markActiveNodes(state.taskGraph.nodes, 'cancelled'),
          expanded: false,
        },
      };
    }

    if (event.kind === 'run_failed') {
      return {
        ...state,
        taskGraph: {
          nodes: markActiveNodes(state.taskGraph.nodes, 'error'),
          expanded: false,
        },
      };
    }

    return state;
  },
};

const agentFocusMechanism: OversightMechanism = {
  id: AGENT_FOCUS_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    if (event.kind === 'tool_started') {
      const showToolName = Boolean(ctx.getParameter(AGENT_FOCUS_MECHANISM_ID, 'showToolName') ?? true);
      return {
        ...state,
        agentFocus: {
          state: 'active',
          toolName: showToolName ? event.toolName : null,
          focusLabel: event.focusLabel,
          updatedAt: event.timestamp,
        },
      };
    }

    if (event.kind === 'run_completed' || event.kind === 'run_cancelled' || event.kind === 'run_failed') {
      return {
        ...state,
        agentFocus: {
          state: 'idle',
          toolName: null,
          focusLabel: event.focusLabel,
          updatedAt: event.timestamp,
        },
      };
    }

    return state;
  },
};

const interventionGateMechanism: OversightMechanism = {
  id: INTERVENTION_GATE_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    if (event.kind === 'risk_signal') {
      const payload = event.signal;
      const impact = asImpact(payload.impact, 'medium');
      const reasons = asStringArray(payload.reasons);
      const reasonText = asString(payload.reason, reasons.join(' '));
      const impactSource: 'llm' | 'heuristic' = asString(payload.impactSource) === 'llm' ? 'llm' : 'heuristic';

      const nextNodes = state.taskGraph.nodes.map((node) => {
        if (node.stepId !== event.stepId) return node;
        return {
          ...node,
          intervention: {
            impact,
            impactSource,
            impactRationale: asString(payload.impactRationale) || undefined,
            requiresApproval: asBoolean(payload.requiresApproval),
            llmRequiresApproval: asBoolean(payload.llmRequiresApproval),
            promptedByGate: asBoolean(payload.promptedByGate),
            gatePolicy: asString(payload.gatePolicy, 'impact'),
            adaptiveGateLevel: asString(payload.adaptiveGateLevel, state.adaptiveState.currentLevel),
            reasonText,
            assumptions: asString(payload.assumptions) || undefined,
            uncertainties: asString(payload.uncertainties) || undefined,
            checkpoints: asString(payload.checkpoints) || undefined,
            amplifiedRisk: asAmplifiedRiskTag(payload.amplifiedRisk),
          },
        };
      });

      return {
        ...state,
        taskGraph: {
          ...state.taskGraph,
          nodes: nextNodes,
        },
        interventionGate: {
          ...state.interventionGate,
          openStepId:
            asBoolean(payload.requiresApproval) || asBoolean(payload.promptedByGate) ? event.stepId : state.interventionGate.openStepId,
        },
      };
    }

    if (event.kind === 'step_context') {
      if (!shouldOpenGateForStep(state, event, ctx)) {
        return state;
      }

      ctx.emitTelemetry?.({ kind: 'intervention_prompted', stepId: event.stepId });

      return {
        ...state,
        interventionGate: {
          ...state.interventionGate,
          openStepId: event.stepId,
          promptedStepIds: state.interventionGate.promptedStepIds.includes(event.stepId)
            ? state.interventionGate.promptedStepIds
            : [...state.interventionGate.promptedStepIds, event.stepId],
        },
      };
    }

    if (event.kind === 'intervention_decision') {
      const nextNodes = state.taskGraph.nodes.map((node) => {
        if (node.stepId !== event.stepId) return node;
        return {
          ...node,
          intervention: {
            ...(node.intervention || {
              impact: 'medium' as StepImpact,
              impactSource: 'heuristic' as const,
              impactRationale: undefined,
              requiresApproval: false,
              llmRequiresApproval: false,
              promptedByGate: false,
              gatePolicy: 'impact',
              adaptiveGateLevel: state.adaptiveState.currentLevel,
              assumptions: undefined,
              uncertainties: undefined,
              checkpoints: undefined,
              amplifiedRisk: null,
            }),
            decision: event.decision,
          },
        };
      });

      return {
        ...state,
        taskGraph: {
          ...state.taskGraph,
          nodes: nextNodes,
        },
        interventionGate: {
          ...state.interventionGate,
          openStepId: state.interventionGate.openStepId === event.stepId ? null : state.interventionGate.openStepId,
          decisions: [...state.interventionGate.decisions, { stepId: event.stepId, decision: event.decision }],
        },
      };
    }

    return state;
  },
};

const adaptiveControllerMechanism: OversightMechanism = {
  id: ADAPTIVE_CONTROLLER_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    let nextState = state;

    if (event.kind === 'step_context') {
      const willPrompt = shouldOpenGateForStep(state, event, ctx);

      if (event.impact === 'high') {
        const elevatedLevel =
          nextState.adaptiveState.currentLevel === 'observe' ? 'impact_gated' : nextState.adaptiveState.currentLevel;
        nextState = transitionOversightLevel(nextState, elevatedLevel, 'high_impact_step_detected', ctx);
      }

      const missedHighRisk = event.impact === 'high' && event.gold_risky && !willPrompt;
      const nextRecentRiskEvents = missedHighRisk
        ? nextState.adaptiveState.recentRiskEvents + 1
        : Math.max(0, nextState.adaptiveState.recentRiskEvents - 1);

      const lowRiskNoInterventionStreak =
        event.impact === 'low' && !willPrompt ? nextState.adaptiveState.lowRiskNoInterventionStreak + 1 : 0;

      nextState = {
        ...nextState,
        adaptiveState: {
          ...nextState.adaptiveState,
          recentRiskEvents: nextRecentRiskEvents,
          lowRiskNoInterventionStreak,
        },
      };

      if (nextRecentRiskEvents >= 2) {
        nextState = transitionOversightLevel(nextState, 'stepwise', 'two_missed_high_risk_events', ctx);
      }

      if (lowRiskNoInterventionStreak >= 5) {
        if (nextState.adaptiveState.currentLevel === 'stepwise') {
          nextState = transitionOversightLevel(nextState, 'impact_gated', 'five_low_risk_without_intervention', ctx);
        } else if (nextState.adaptiveState.currentLevel === 'impact_gated') {
          nextState = transitionOversightLevel(nextState, 'observe', 'five_low_risk_without_intervention', ctx);
        }
      }
    }

    if (event.kind === 'intervention_decision') {
      const nextApprovals = event.decision === 'approve' ? nextState.adaptiveState.consecutiveApprovals + 1 : 0;
      nextState = {
        ...nextState,
        adaptiveState: {
          ...nextState.adaptiveState,
          consecutiveApprovals: nextApprovals,
        },
      };
    }

    return nextState;
  },
};

const mechanisms: OversightMechanism[] = [
  taskGraphMechanism,
  agentFocusMechanism,
  interventionGateMechanism,
  adaptiveControllerMechanism,
];

export function createInitialOversightState(): OversightUiState {
  return {
    taskGraph: {
      nodes: [],
      expanded: false,
    },
    agentFocus: {
      state: 'idle',
      toolName: null,
      focusLabel: 'Waiting for agent action',
      updatedAt: Date.now(),
    },
    thinkingByStepId: {},
    interventionGate: {
      openStepId: null,
      promptedStepIds: [],
      decisions: [],
    },
    adaptiveState: {
      currentLevel: 'observe',
      recentRiskEvents: 0,
      consecutiveApprovals: 0,
      lowRiskNoInterventionStreak: 0,
    },
    runtime: {
      authorityState: 'agent_autonomous',
      executionPhase: 'planning',
      executionState: 'running',
      updatedAt: Date.now(),
    },
  };
}

export class OversightMechanismManager {
  private config: OversightConfig;

  constructor(config: OversightConfig) {
    this.config = config;
  }

  setConfig(config: OversightConfig): void {
    this.config = config;
  }

  private getParameter(mechanismId: OversightMechanismId, parameterKey: string): OversightParameterValue | undefined {
    const configured = this.config.parameterSettings[mechanismId]?.[parameterKey];
    if (configured !== undefined) {
      return configured;
    }
    return getOversightParameterDefaultValue(mechanismId, parameterKey);
  }

  reduce(state: OversightUiState, event: OversightEvent, ctx: OversightContextInput): OversightUiState {
    let nextState = state;
    const context: OversightContext = {
      ...ctx,
      getParameter: (mechanismId, parameterKey) => this.getParameter(mechanismId, parameterKey),
    };

    for (const mechanism of mechanisms) {
      if (!this.config.enabledMechanisms[mechanism.id]) continue;
      nextState = mechanism.reduce(nextState, event, context);
    }

    if (event.kind === 'authority_transition') {
      nextState = {
        ...nextState,
        runtime: {
          ...nextState.runtime,
          authorityState: event.to,
          updatedAt: event.timestamp,
        },
      };
    } else if (event.kind === 'execution_phase_changed') {
      nextState = {
        ...nextState,
        runtime: {
          ...nextState.runtime,
          executionPhase: event.to,
          updatedAt: event.timestamp,
        },
      };
    } else if (event.kind === 'execution_state_changed') {
      nextState = {
        ...nextState,
        runtime: {
          ...nextState.runtime,
          executionState: event.to,
          updatedAt: event.timestamp,
        },
      };
    }

    return nextState;
  }
}
