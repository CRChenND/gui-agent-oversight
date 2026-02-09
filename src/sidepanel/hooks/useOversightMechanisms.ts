import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type OversightMechanismParameterSettings,
  TASK_GRAPH_MECHANISM_ID,
  type OversightMechanismSettings,
} from '../../oversight/registry';
import { getOversightSessionManager } from '../../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../../oversight/telemetry/types';
import type { OversightEvent } from '../../oversight/types';
import {
  createInitialOversightState,
  OversightMechanismManager,
  type OversightUiState,
} from '../oversight/mechanismManager';

interface UseOversightMechanismsProps {
  mechanismSettings: OversightMechanismSettings;
  mechanismParameterSettings: OversightMechanismParameterSettings;
  getLatestThinking: () => string;
}

export function useOversightMechanisms({
  mechanismSettings,
  mechanismParameterSettings,
  getLatestThinking,
}: UseOversightMechanismsProps) {
  const [state, setState] = useState<OversightUiState>(() => createInitialOversightState());

  const managerRef = useRef(
    new OversightMechanismManager({
      enabledMechanisms: mechanismSettings,
      parameterSettings: mechanismParameterSettings,
    })
  );

  useEffect(() => {
    managerRef.current.setConfig({
      enabledMechanisms: mechanismSettings,
      parameterSettings: mechanismParameterSettings,
    });
  }, [mechanismSettings, mechanismParameterSettings]);

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

  const logHumanTelemetry = useCallback(
    async (eventType: OversightTelemetryEvent['eventType'], payload: Record<string, any>) => {
      const sessionManager = getOversightSessionManager();
      const logger = getOversightTelemetryLogger();
      const sessionId = (await sessionManager.getActiveSessionId()) ?? (await sessionManager.startSession());

      logger.log({
        sessionId,
        timestamp: Date.now(),
        source: 'human',
        eventType,
        payload,
      });
    },
    []
  );

  const handleOversightEvent = useCallback(
    (event: OversightEvent) => {
      setState((prev) => managerRef.current.reduce(prev, event, { getLatestThinking }));
    },
    [getLatestThinking]
  );

  const replayOversightEvents = useCallback(
    (events: OversightEvent[]) => {
      const base = createInitialOversightState();
      const nextState = events.reduce(
        (acc, event) => managerRef.current.reduce(acc, event, { getLatestThinking }),
        base
      );
      setState(nextState);
    },
    [getLatestThinking]
  );

  const setTaskGraphExpanded = useCallback((expanded: boolean) => {
    if (expanded) {
      void logHumanTelemetry('human_monitoring', {
        action: 'explanation_expanded',
      });
    }

    setState((prev) => ({
      ...prev,
      taskGraph: {
        ...prev.taskGraph,
        expanded,
      },
    }));
  }, [logHumanTelemetry]);

  const resetRunState = useCallback(() => {
    setState((prev) => ({
      ...prev,
      taskGraph: {
        nodes: [],
        expanded: mechanismSettings[TASK_GRAPH_MECHANISM_ID],
      },
      thinkingByStepId: {},
    }));
  }, [mechanismSettings]);

  const clearOversightState = useCallback(() => {
    setState((prev) => ({
      ...prev,
      taskGraph: {
        nodes: [],
        expanded: false,
      },
      thinkingByStepId: {},
    }));
  }, []);

  return useMemo(
    () => ({
      taskNodes: state.taskGraph.nodes,
      isTaskGraphExpanded: state.taskGraph.expanded,
      setTaskGraphExpanded,
      agentFocus: state.agentFocus,
      handleOversightEvent,
      replayOversightEvents,
      logHumanTelemetry,
      resetRunState,
      clearOversightState,
    }),
    [
      state,
      setTaskGraphExpanded,
      handleOversightEvent,
      replayOversightEvents,
      logHumanTelemetry,
      resetRunState,
      clearOversightState
    ]
  );
}
