import type { AgentThinkingSummary } from '../types';
import { enforceThinkingSizeLimit, redactThinking, type TelemetryRedactionLevel } from './redaction';
import type { OversightTelemetryEvent } from './types';

const TELEMETRY_STORAGE_KEY = 'oversight.telemetry.sessions';
const TELEMETRY_REDACTION_LEVEL_KEY = 'telemetry.redactionLevel';
const TELEMETRY_REDACTION_MAX_TEXT_KEY = 'telemetry.redactionMaxTextLength';

type TelemetryStorage = Record<string, OversightTelemetryEvent[]>;

function normalizeTelemetryStorage(value: unknown): TelemetryStorage {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  const normalized: TelemetryStorage = {};

  for (const [sessionId, events] of Object.entries(record)) {
    if (!Array.isArray(events)) continue;
    normalized[sessionId] = events.filter((event): event is OversightTelemetryEvent => {
      if (!event || typeof event !== 'object') return false;
      const maybeEvent = event as OversightTelemetryEvent;
      return (
        typeof maybeEvent.sessionId === 'string' &&
        typeof maybeEvent.timestamp === 'number' &&
        typeof maybeEvent.source === 'string' &&
        typeof maybeEvent.eventType === 'string' &&
        typeof maybeEvent.payload === 'object' &&
        maybeEvent.payload !== null
      );
    });
  }

  return normalized;
}

export class OversightTelemetryLogger {
  private sessionEvents = new Map<string, OversightTelemetryEvent[]>();
  private flushedCounts = new Map<string, number>();
  private isInitialized = false;
  private flushQueue: Promise<void> = Promise.resolve();
  private redactionLevel: TelemetryRedactionLevel = 'normal';
  private redactionMaxTextLength: number | undefined = 320;

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    const [localStored, syncStored] = await Promise.all([
      chrome.storage.local.get(TELEMETRY_STORAGE_KEY),
      chrome.storage.sync.get({
        [TELEMETRY_REDACTION_LEVEL_KEY]: 'normal',
        [TELEMETRY_REDACTION_MAX_TEXT_KEY]: 320,
      }),
    ]);
    const normalized = normalizeTelemetryStorage(localStored[TELEMETRY_STORAGE_KEY]);

    const maybeLevel = syncStored[TELEMETRY_REDACTION_LEVEL_KEY];
    if (maybeLevel === 'strict' || maybeLevel === 'normal' || maybeLevel === 'off') {
      this.redactionLevel = maybeLevel;
    }

    const maybeMaxLength = syncStored[TELEMETRY_REDACTION_MAX_TEXT_KEY];
    if (typeof maybeMaxLength === 'number' && Number.isFinite(maybeMaxLength) && maybeMaxLength > 0) {
      this.redactionMaxTextLength = maybeMaxLength;
    }

    for (const [sessionId, events] of Object.entries(normalized)) {
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      const pendingLocal = this.sessionEvents.get(sessionId) ?? [];
      const merged = [...sorted, ...pendingLocal].sort((a, b) => a.timestamp - b.timestamp);
      this.sessionEvents.set(sessionId, merged);
      this.flushedCounts.set(sessionId, sorted.length);
    }

    this.isInitialized = true;
  }

  private sanitizeThinkingPayload(event: OversightTelemetryEvent): OversightTelemetryEvent {
    if (event.eventType !== 'agent_thinking') {
      return event;
    }

    const maybeThinking = event.payload?.thinkingSummary as AgentThinkingSummary | undefined;
    if (!maybeThinking || typeof maybeThinking.goal !== 'string') {
      return event;
    }

    const redacted = redactThinking(maybeThinking, this.redactionLevel, this.redactionMaxTextLength);
    const bounded = enforceThinkingSizeLimit(redacted);

    return {
      ...event,
      payload: {
        ...event.payload,
        thinkingSummary: bounded,
      },
    };
  }

  log(event: OversightTelemetryEvent): void {
    if (!this.isInitialized) {
      void this.ensureInitialized();
    }

    const current = this.sessionEvents.get(event.sessionId) ?? [];
    current.push(this.sanitizeThinkingPayload(event));
    current.sort((a, b) => a.timestamp - b.timestamp);
    this.sessionEvents.set(event.sessionId, current);

    this.flushQueue = this.flushQueue
      .then(async () => {
        await this.flush();
      })
      .catch((error) => {
        console.warn('Telemetry flush failed:', error);
      });
  }

  async flush(): Promise<void> {
    await this.ensureInitialized();

    const stored = await chrome.storage.local.get(TELEMETRY_STORAGE_KEY);
    const mergedStorage = normalizeTelemetryStorage(stored[TELEMETRY_STORAGE_KEY]);

    for (const [sessionId, events] of this.sessionEvents.entries()) {
      const alreadyFlushed = this.flushedCounts.get(sessionId) ?? 0;
      const pending = events.slice(alreadyFlushed);
      if (pending.length === 0) continue;

      const existing = mergedStorage[sessionId] ?? [];
      mergedStorage[sessionId] = existing.concat(pending).sort((a, b) => a.timestamp - b.timestamp);
      this.flushedCounts.set(sessionId, events.length);
      this.sessionEvents.set(sessionId, mergedStorage[sessionId]);
    }

    await chrome.storage.local.set({ [TELEMETRY_STORAGE_KEY]: mergedStorage });
  }

  getSessionEvents(sessionId: string): OversightTelemetryEvent[] {
    return [...(this.sessionEvents.get(sessionId) ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  }

  getSessionEventsByStepId(sessionId: string, stepId: string): OversightTelemetryEvent[] {
    return this.getSessionEvents(sessionId).filter((event) => event.payload?.stepId === stepId);
  }

  async exportSessionLog(sessionId: string): Promise<string> {
    await this.flush();
    const events = this.getSessionEvents(sessionId);
    const groupedByStepId: Record<string, OversightTelemetryEvent[]> = {};

    for (const event of events) {
      const stepId = typeof event.payload?.stepId === 'string' ? event.payload.stepId : '';
      if (!stepId) continue;
      groupedByStepId[stepId] = groupedByStepId[stepId] ?? [];
      groupedByStepId[stepId].push(event);
    }

    return JSON.stringify(
      {
        sessionId,
        exportedAt: Date.now(),
        events: events.map((event) => ({
          sessionId: event.sessionId,
          stepId: typeof event.payload?.stepId === 'string' ? event.payload.stepId : undefined,
          timestamp: event.timestamp,
          eventType: event.eventType,
          thinkingSummary: event.payload?.thinkingSummary,
          mechanismState: event.payload?.mechanismState,
          humanInteraction: event.source === 'human' ? event.payload : undefined,
          source: event.source,
          payload: event.payload,
        })),
        groupedByStepId,
      },
      null,
      2
    );
  }
}

let loggerSingleton: OversightTelemetryLogger | null = null;

export function getOversightTelemetryLogger(): OversightTelemetryLogger {
  if (!loggerSingleton) {
    loggerSingleton = new OversightTelemetryLogger();
  }
  return loggerSingleton;
}
