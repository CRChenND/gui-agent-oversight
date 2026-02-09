import type { OversightEvent } from '../../oversight/types';
import {
  AGENT_FOCUS_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  getOversightParameterDefaultValue,
  type OversightMechanismId,
  type OversightMechanismParameterSettings,
  type OversightParameterValue,
  type OversightMechanismSettings,
} from '../../oversight/registry';
import type { TaskNode, TaskNodeStatus } from '../components/TaskExecutionGraph';
import type { AgentThinkingSummary } from '../../oversight/types';

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

export interface OversightUiState {
  taskGraph: {
    nodes: TaskNode[];
    expanded: boolean;
  };
  agentFocus: AgentFocusState;
  thinkingByStepId: Record<string, AgentThinkingSummary>;
}

interface OversightContextInput {
  getLatestThinking: () => string;
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

const taskGraphMechanism: OversightMechanism = {
  id: TASK_GRAPH_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    if (event.kind === 'tool_started') {
      const maxNodes = Math.max(
        1,
        Number(ctx.getParameter(TASK_GRAPH_MECHANISM_ID, 'maxNodes') ?? 20)
      );
      const autoExpand = Boolean(ctx.getParameter(TASK_GRAPH_MECHANISM_ID, 'autoExpand') ?? true);

      const nextNodes = markActiveNodes(state.taskGraph.nodes, 'completed');
      nextNodes.push({
        id: event.stepId,
        stepId: event.stepId,
        toolName: event.toolName,
        focusLabel: event.focusLabel || 'Focus updated',
        thinking: state.thinkingByStepId[event.stepId]?.rationale || state.thinkingByStepId[event.stepId]?.goal || ctx.getLatestThinking(),
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

const mechanisms: OversightMechanism[] = [taskGraphMechanism, agentFocusMechanism];

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

  private getParameter(
    mechanismId: OversightMechanismId,
    parameterKey: string
  ): OversightParameterValue | undefined {
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

    return nextState;
  }
}
