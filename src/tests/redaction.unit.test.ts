import { enforceThinkingSizeLimit, redactThinking } from '../oversight/telemetry/redaction';
import { assert, assertEqual } from './testUtils';

export function testThinkingRedactionMasksSensitiveData(): void {
  const redacted = redactThinking({
    goal: 'Contact john.doe@example.com and call 555-123-4567',
    rationale: 'Use card 4111 1111 1111 1111 to complete checkout.',
  });

  assert(redacted.goal.includes('[REDACTED_EMAIL]'), 'Email should be redacted from goal');
  assert(redacted.goal.includes('[REDACTED_PHONE]'), 'Phone number should be redacted from goal');
  assert((redacted.rationale || '').includes('[REDACTED_CARD]'), 'Credit card should be redacted from rationale');
  assert((redacted.redactionsApplied || []).length > 0, 'Redaction metadata should be populated');
}

export function testThinkingSizeLimit(): void {
  const oversized = {
    goal: 'x'.repeat(600),
    rationale: 'y'.repeat(1600),
    plan: ['z'.repeat(400), 'z'.repeat(400), 'z'.repeat(400), 'z'.repeat(400)],
  };
  const bounded = enforceThinkingSizeLimit(oversized, 2048);
  assert(JSON.stringify(bounded).length <= 2048, 'Thinking payload should remain under 2KB');
}

export function runRedactionUnitTests(): void {
  testThinkingRedactionMasksSensitiveData();
  testThinkingSizeLimit();
  assertEqual(true, true, 'Redaction unit tests passed');
}

