import type { OversightEvent } from '../../oversight/types';
import {
  AGENT_FOCUS_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  type OversightMechanismId,
  type OversightMechanismSettings,
} from '../../oversight/registry';
import type { TaskNode, TaskNodeStatus } from '../components/TaskExecutionGraph';

export interface OversightConfig {
  enabledMechanisms: OversightMechanismSettings;
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
}

interface OversightContext {
  getLatestThinking: () => string;
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
      const nextNodes = markActiveNodes(state.taskGraph.nodes, 'completed');
      nextNodes.push({
        id: `${event.timestamp}-${event.toolName}`,
        toolName: event.toolName,
        focusLabel: event.focusLabel || 'Focus updated',
        thinking: ctx.getLatestThinking(),
        status: 'active',
        timestamp: event.timestamp,
      });

      return {
        ...state,
        taskGraph: {
          nodes: nextNodes,
          expanded: true,
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
  reduce: (state, event) => {
    if (event.kind === 'tool_started') {
      return {
        ...state,
        agentFocus: {
          state: 'active',
          toolName: event.toolName,
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

  reduce(state: OversightUiState, event: OversightEvent, ctx: OversightContext): OversightUiState {
    let nextState = state;

    for (const mechanism of mechanisms) {
      if (!this.config.enabledMechanisms[mechanism.id]) continue;
      nextState = mechanism.reduce(nextState, event, ctx);
    }

    return nextState;
  }
}
