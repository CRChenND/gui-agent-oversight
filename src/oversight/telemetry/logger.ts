import type { OversightTelemetryEvent } from './types';

const TELEMETRY_STORAGE_KEY = 'oversight.telemetry.sessions';

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

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    const stored = await chrome.storage.local.get(TELEMETRY_STORAGE_KEY);
    const normalized = normalizeTelemetryStorage(stored[TELEMETRY_STORAGE_KEY]);

    for (const [sessionId, events] of Object.entries(normalized)) {
      this.sessionEvents.set(sessionId, [...events]);
      this.flushedCounts.set(sessionId, events.length);
    }

    this.isInitialized = true;
  }

  log(event: OversightTelemetryEvent): void {
    const current = this.sessionEvents.get(event.sessionId) ?? [];
    current.push(event);
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
      mergedStorage[sessionId] = existing.concat(pending);
      this.flushedCounts.set(sessionId, events.length);
      this.sessionEvents.set(sessionId, mergedStorage[sessionId]);
    }

    await chrome.storage.local.set({ [TELEMETRY_STORAGE_KEY]: mergedStorage });
  }

  getSessionEvents(sessionId: string): OversightTelemetryEvent[] {
    return [...(this.sessionEvents.get(sessionId) ?? [])];
  }

  async exportSessionLog(sessionId: string): Promise<string> {
    await this.flush();
    return JSON.stringify(this.getSessionEvents(sessionId), null, 2);
  }
}

let loggerSingleton: OversightTelemetryLogger | null = null;

export function getOversightTelemetryLogger(): OversightTelemetryLogger {
  if (!loggerSingleton) {
    loggerSingleton = new OversightTelemetryLogger();
  }
  return loggerSingleton;
}
