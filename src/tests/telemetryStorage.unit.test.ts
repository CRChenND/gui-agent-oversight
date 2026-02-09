import { OversightTelemetryLogger } from '../oversight/telemetry/logger';
import { assert } from './testUtils';

interface LocalStorageRecord {
  [key: string]: unknown;
}

function installChromeMock(initial: LocalStorageRecord = {}): void {
  const localStorageData: LocalStorageRecord = { ...initial };
  const syncStorageData: LocalStorageRecord = {
    'telemetry.redactionLevel': 'normal',
    'telemetry.redactionMaxTextLength': 320,
  };

  (globalThis as unknown as { chrome: typeof chrome }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: localStorageData[key] }),
        set: async (value: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(value)) localStorageData[k] = v;
        },
      },
      sync: {
        get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...syncStorageData }),
      },
    },
  } as unknown as typeof chrome;
}

export async function testTelemetryStoragePersistsThinkingEvent(): Promise<void> {
  installChromeMock();
  const logger = new OversightTelemetryLogger();
  logger.log({
    sessionId: 's-test',
    timestamp: 100,
    source: 'agent',
    eventType: 'agent_thinking',
    payload: {
      phase: 'agent_thinking',
      stepId: 'step_1',
      thinkingSummary: {
        goal: 'Email me at jane@example.com',
      },
    },
  });
  await logger.flush();

  const events = logger.getSessionEvents('s-test');
  assert(events.length === 1, 'Telemetry logger should store one event');
  assert(events[0].payload?.stepId === 'step_1', 'Stored telemetry should retain stepId');
  assert(
    String(events[0].payload?.thinkingSummary?.goal || '').includes('[REDACTED_EMAIL]'),
    'Stored thinking should be redacted before persistence'
  );
}

