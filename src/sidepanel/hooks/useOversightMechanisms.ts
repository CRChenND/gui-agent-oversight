import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OversightEvent } from '../../oversight/types';
import {
  createInitialOversightState,
  OversightMechanismManager,
  type OversightUiState,
} from '../oversight/mechanismManager';
import {
  TASK_GRAPH_MECHANISM_ID,
  type OversightMechanismSettings,
} from '../../oversight/registry';

interface UseOversightMechanismsProps {
  mechanismSettings: OversightMechanismSettings;
  getLatestThinking: () => string;
}

export function useOversightMechanisms({
  mechanismSettings,
  getLatestThinking,
}: UseOversightMechanismsProps) {
  const [state, setState] = useState<OversightUiState>(() => createInitialOversightState());

  const managerRef = useRef(
    new OversightMechanismManager({
      enabledMechanisms: mechanismSettings,
    })
  );

  useEffect(() => {
    managerRef.current.setConfig({ enabledMechanisms: mechanismSettings });
  }, [mechanismSettings]);

  useEffect(() => {
    if (!mechanismSettings[TASK_GRAPH_MECHANISM_ID]) {
      setState((prev) => ({
        ...prev,
        taskGraph: {
          nodes: [],
          expanded: false,
        },
      }));
    }
  }, [mechanismSettings]);

  const handleOversightEvent = useCallback(
    (event: OversightEvent) => {
      setState((prev) => managerRef.current.reduce(prev, event, { getLatestThinking }));
    },
    [getLatestThinking]
  );

  const setTaskGraphExpanded = useCallback((expanded: boolean) => {
    setState((prev) => ({
      ...prev,
      taskGraph: {
        ...prev.taskGraph,
        expanded,
      },
    }));
  }, []);

  const resetRunState = useCallback(() => {
    setState((prev) => ({
      ...prev,
      taskGraph: {
        nodes: [],
        expanded: mechanismSettings[TASK_GRAPH_MECHANISM_ID],
      },
    }));
  }, [mechanismSettings]);

  const clearOversightState = useCallback(() => {
    setState((prev) => ({
      ...prev,
      taskGraph: {
        nodes: [],
        expanded: false,
      },
    }));
  }, []);

  return useMemo(
    () => ({
      taskNodes: state.taskGraph.nodes,
      isTaskGraphExpanded: state.taskGraph.expanded,
      setTaskGraphExpanded,
      agentFocus: state.agentFocus,
      handleOversightEvent,
      resetRunState,
      clearOversightState,
    }),
    [state, setTaskGraphExpanded, handleOversightEvent, resetRunState, clearOversightState]
  );
}
