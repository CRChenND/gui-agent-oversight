import { createStepId } from '../agent/thinking/thinkingSummary';
import { buildStepInspectionData } from '../replay/replayController';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import { assert, assertEqual } from './testUtils';

export function testStepIdUniqueness(): void {
  const stepA = createStepId(1);
  const stepB = createStepId(1);
  assert(stepA !== stepB, 'Generated step IDs should be unique even within the same step counter');
}

export function testStepIdInspectionLinking(): void {
  const stepId = 'step_7_test';
  const events: OversightTelemetryEvent[] = [
    {
      sessionId: 's1',
      timestamp: 1,
      source: 'agent',
      eventType: 'agent_thinking',
      payload: {
        phase: 'agent_thinking',
        stepId,
        toolName: 'click',
        thinkingSummary: {
          goal: 'Submit form',
          rationale: 'Need to click submit button',
        },
      },
    },
    {
      sessionId: 's1',
      timestamp: 2,
      source: 'agent',
      eventType: 'agent_action',
      payload: {
        phase: 'tool_started',
        stepId,
        toolName: 'click',
        toolInput: '#submit',
      },
    },
  ];

  const inspection = buildStepInspectionData(stepId, events);
  assert(inspection !== null, 'Step inspection should be built for matching stepId');
  assertEqual(inspection?.stepId, stepId, 'Step inspection should preserve stepId');
  assertEqual(inspection?.goal, 'Submit form', 'Step inspection should include linked thinking goal');
}

export function runStepIdLinkingUnitTests(): void {
  testStepIdUniqueness();
  testStepIdInspectionLinking();
}

