import type { AgentThinkingSummary } from '../types';
import type { OversightEscalationMetrics, OversightRhythmMetrics } from '../runtime/types';
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

    const oversightRhythmMetrics = this.computeOversightRhythmMetrics(events);
    const oversightEscalationMetrics = this.computeOversightEscalationMetrics(events);

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
        oversightRhythmMetrics,
        oversightEscalationMetrics,
      },
      null,
      2
    );
  }

  private computeOversightRhythmMetrics(events: OversightTelemetryEvent[]): OversightRhythmMetrics {
    const interruptionEvents = events
      .filter((event) => {
        const kind = event.payload?.kind;
        return kind === 'intervention_prompted' || kind === 'execution_paused' || kind === 'authority_takeover';
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    const intervals: number[] = [];
    for (let i = 1; i < interruptionEvents.length; i++) {
      intervals.push(Math.max(0, interruptionEvents[i].timestamp - interruptionEvents[i - 1].timestamp));
    }

    const enforcedInterruptions = events.filter((event) => event.payload?.kind === 'intervention_prompted').length;
    const userInitiatedInterruptions = events.filter((event) => {
      if (event.payload?.kind === 'authority_takeover') return true;
      return event.payload?.kind === 'execution_paused' && event.payload?.by === 'user';
    }).length;
    const authorityTransitionCount = events.filter((event) => event.payload?.kind === 'authority_transition').length;
    const amplificationEntered = events
      .filter((event) => event.payload?.kind === 'amplification_entered')
      .sort((a, b) => a.timestamp - b.timestamp);
    const amplificationExited = events
      .filter((event) => event.payload?.kind === 'amplification_exited')
      .sort((a, b) => a.timestamp - b.timestamp);
    const softPauseDurations = events
      .filter((event) => event.payload?.kind === 'soft_pause_resolved')
      .map((event) => Math.max(0, Number(event.payload?.durationMs || 0)));
    const intentRefreshCount = events.filter((event) => event.payload?.kind === 'intent_refresh_triggered').length;

    const amplificationDurations: number[] = [];
    for (const entered of amplificationEntered) {
      const exited = amplificationExited.find((candidate) => candidate.timestamp >= entered.timestamp);
      if (exited) {
        amplificationDurations.push(Math.max(0, exited.timestamp - entered.timestamp));
      }
    }
    const amplificationDurationMs = amplificationDurations.reduce((sum, value) => sum + value, 0);

    return {
      totalInterruptions: interruptionEvents.length,
      enforcedInterruptions,
      userInitiatedInterruptions,
      meanInterruptionIntervalMs:
        intervals.length > 0 ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0,
      authorityTransitionCount,
      amplificationDurationMs,
      amplificationEntryCount: amplificationEntered.length,
      meanSoftPauseDurationMs:
        softPauseDurations.length > 0
          ? softPauseDurations.reduce((sum, value) => sum + value, 0) / softPauseDurations.length
          : 0,
      intentRefreshCount,
    };
  }

  private computeOversightEscalationMetrics(events: OversightTelemetryEvent[]): OversightEscalationMetrics {
    const transitions = events
      .filter((event) => event.payload?.kind === 'regime_transition' && event.payload?.trigger === 'behavioral')
      .sort((a, b) => a.timestamp - b.timestamp);

    const entered = transitions.filter((event) => event.payload?.to === 'deliberative_escalated');
    const resolved = transitions.filter((event) => event.payload?.from === 'deliberative_escalated' && event.payload?.to === 'baseline');

    const durations: number[] = [];
    let resolutionLatencySum = 0;
    let resolutionLatencyCount = 0;
    for (const entry of entered) {
      const resolvedEvent = resolved.find((item) => item.timestamp >= entry.timestamp);
      if (!resolvedEvent) continue;
      const duration = Math.max(0, resolvedEvent.timestamp - entry.timestamp);
      durations.push(duration);
      resolutionLatencySum += duration;
      resolutionLatencyCount += 1;
    }

    const triggerDistribution = events.reduce(
      (acc, event) => {
        if (event.payload?.kind !== 'behavioral_signal_captured') return acc;
        if (event.payload?.signal === 'pause_by_user') acc.pause += 1;
        if (event.payload?.signal === 'expand_trace_node' || event.payload?.signal === 'repeated_trace_expansion') {
          acc.trace_expand += 1;
        }
        if (event.payload?.signal === 'hover_risk_label') acc.hover += 1;
        if (event.payload?.signal === 'edit_intermediate_output') acc.edit += 1;
        return acc;
      },
      { pause: 0, trace_expand: 0, hover: 0, edit: 0 }
    );

    return {
      totalEscalations: entered.length,
      meanEscalationDurationMs:
        durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      maxEscalationDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      escalationTriggerDistribution: triggerDistribution,
      resolutionLatencyMs: resolutionLatencyCount > 0 ? resolutionLatencySum / resolutionLatencyCount : 0,
    };
  }
}

let loggerSingleton: OversightTelemetryLogger | null = null;

export function getOversightTelemetryLogger(): OversightTelemetryLogger {
  if (!loggerSingleton) {
    loggerSingleton = new OversightTelemetryLogger();
  }
  return loggerSingleton;
}
