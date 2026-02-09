import { emitAgentThinking, registerThinkingDispatch } from '../agent/thinking/thinkingEmitter';
import { TracePlaybackController } from '../replay/replayController';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import { assert, assertEqual } from './testUtils';

function installTraceStorage(eventsBySession: Record<string, OversightTelemetryEvent[]>): void {
  (globalThis as unknown as { chrome: typeof chrome }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: eventsBySession }),
      },
    },
  } as unknown as typeof chrome;
}

export function testAgentStepProducesThinkingEvent(): void {
  let capturedStepId = '';
  registerThinkingDispatch((event) => {
    if (event.kind === 'agent_thinking') {
      capturedStepId = event.stepId;
    }
  });

  emitAgentThinking('step_emit_1', 'click', { goal: 'Click submit' });
  assertEqual(capturedStepId, 'step_emit_1', 'Thinking emission should preserve stepId');
}

export async function testTracePlaybackReconstructsVisibleState(): Promise<void> {
  const sessionId = 'session_trace_1';
  installTraceStorage({
    [sessionId]: [
      {
        sessionId,
        timestamp: 1,
        source: 'agent',
        eventType: 'agent_thinking',
        payload: {
          phase: 'agent_thinking',
          stepId: 'step_a',
          toolName: 'click',
          thinkingSummary: { goal: 'Open menu' },
        },
      },
      {
        sessionId,
        timestamp: 2,
        source: 'agent',
        eventType: 'agent_action',
        payload: {
          phase: 'tool_started',
          stepId: 'step_a',
          toolName: 'click',
          toolInput: '#menu',
          focusType: 'selector',
          focusLabel: 'Menu',
        },
      },
      {
        sessionId,
        timestamp: 3,
        source: 'system',
        eventType: 'state_transition',
        payload: { phase: 'run_completed', focusLabel: 'Task completed' },
      },
    ],
  });

  const controller = new TracePlaybackController();
  await controller.loadSession(sessionId);
  controller.stepForward();
  controller.stepForward();

  const visible = controller.getVisibleEvents();
  assert(visible.length === 2, 'Visible events should track cursor stepping');
  assertEqual(controller.getCurrentStepId(), 'step_a', 'Current step ID should resolve from visible trace');
  assert(controller.getStepInspection('step_a') !== null, 'Step inspector data should load from telemetry');
}

