import { createStepId } from '../agent/thinking/thinkingSummary';
import { assert } from './testUtils';

export function testStepIdUniqueness(): void {
  const stepA = createStepId(1);
  const stepB = createStepId(1);
  assert(stepA !== stepB, 'Generated step IDs should be unique even within the same step counter');
}

export function runStepIdLinkingUnitTests(): void {
  testStepIdUniqueness();
}
