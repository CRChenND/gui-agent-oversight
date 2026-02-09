import type { OversightEvent } from '../oversight/types';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';

const TELEMETRY_STORAGE_KEY = 'oversight.telemetry.sessions';

type TelemetryStorage = Record<string, OversightTelemetryEvent[]>;

export interface ReplaySessionSummary {
  sessionId: string;
  eventCount: number;
  startedAt: number;
  endedAt: number;
}

function toOversightEvent(event: OversightTelemetryEvent): OversightEvent | null {
  const phase = typeof event.payload?.phase === 'string' ? event.payload.phase : '';

  if (event.eventType === 'agent_action' && phase === 'tool_started') {
    return {
      kind: 'tool_started',
      timestamp: event.timestamp,
      toolName: typeof event.payload.toolName === 'string' ? event.payload.toolName : 'unknown_tool',
      toolInput: typeof event.payload.toolInput === 'string' ? event.payload.toolInput : '',
      focusType: event.payload.focusType || 'none',
      focusLabel: typeof event.payload.focusLabel === 'string' ? event.payload.focusLabel : 'Focus updated',
    };
  }

  if (event.eventType === 'state_transition' && phase === 'run_completed') {
    return {
      kind: 'run_completed',
      timestamp: event.timestamp,
      focusLabel: typeof event.payload.focusLabel === 'string' ? event.payload.focusLabel : 'Task completed',
    };
  }

  if (event.eventType === 'state_transition' && phase === 'run_cancelled') {
    return {
      kind: 'run_cancelled',
      timestamp: event.timestamp,
      focusLabel: typeof event.payload.focusLabel === 'string' ? event.payload.focusLabel : 'Execution cancelled',
    };
  }

  if (event.eventType === 'state_transition' && phase === 'run_failed') {
    return {
      kind: 'run_failed',
      timestamp: event.timestamp,
      focusLabel: typeof event.payload.focusLabel === 'string' ? event.payload.focusLabel : 'Execution failed',
      error: typeof event.payload.error === 'string' ? event.payload.error : undefined,
    };
  }

  return null;
}

async function readStorage(): Promise<TelemetryStorage> {
  const result = await chrome.storage.local.get(TELEMETRY_STORAGE_KEY);
  const raw = result[TELEMETRY_STORAGE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw as TelemetryStorage;
}

export class ReplayController {
  private sessionId: string | null = null;
  private replayEvents: OversightEvent[] = [];
  private cursor = -1;

  async listSessions(): Promise<ReplaySessionSummary[]> {
    const storage = await readStorage();
    const summaries: ReplaySessionSummary[] = [];

    for (const [sessionId, events] of Object.entries(storage)) {
      if (!Array.isArray(events) || events.length === 0) continue;
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      summaries.push({
        sessionId,
        eventCount: sorted.length,
        startedAt: sorted[0].timestamp,
        endedAt: sorted[sorted.length - 1].timestamp,
      });
    }

    return summaries.sort((a, b) => b.startedAt - a.startedAt);
  }

  async loadSession(sessionId: string): Promise<void> {
    const storage = await readStorage();
    const events = Array.isArray(storage[sessionId]) ? storage[sessionId] : [];

    this.sessionId = sessionId;
    this.cursor = -1;
    this.replayEvents = events
      .map(toOversightEvent)
      .filter((event): event is OversightEvent => event !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  stepForward(): void {
    if (this.cursor < this.replayEvents.length - 1) {
      this.cursor += 1;
    }
  }

  stepBackward(): void {
    if (this.cursor >= 0) {
      this.cursor -= 1;
    }
  }

  jumpTo(timestamp: number): void {
    let idx = -1;
    for (let i = 0; i < this.replayEvents.length; i++) {
      if (this.replayEvents[i].timestamp <= timestamp) {
        idx = i;
      } else {
        break;
      }
    }
    this.cursor = idx;
  }

  getLoadedSessionId(): string | null {
    return this.sessionId;
  }

  getReplayEvents(): OversightEvent[] {
    return [...this.replayEvents];
  }

  getVisibleEvents(): OversightEvent[] {
    if (this.cursor < 0) return [];
    return this.replayEvents.slice(0, this.cursor + 1);
  }

  getCursor(): number {
    return this.cursor;
  }
}
