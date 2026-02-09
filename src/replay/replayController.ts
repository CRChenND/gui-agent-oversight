import type { AgentThinkingSummary, OversightEvent } from '../oversight/types';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';

const TELEMETRY_STORAGE_KEY = 'oversight.telemetry.sessions';

type TelemetryStorage = Record<string, OversightTelemetryEvent[]>;

export interface TracePlaybackSessionSummary {
  sessionId: string;
  eventCount: number;
  startedAt: number;
  endedAt: number;
}

export interface TraceStepSummary {
  stepId: string;
  timestamp: number;
  toolName: string;
}

export interface StepInspectionData {
  stepId: string;
  timestamp: number;
  toolName: string;
  goal: string;
  plan: string[];
  memoryRead: string[];
  memoryWrite: string[];
  rationale: string;
  uncertainty: 'low' | 'med' | 'high' | 'unknown';
  riskFlags: string[];
  triggeredMechanisms: string[];
  parametersAtRuntime: Record<string, unknown>;
  interventionActions: string[];
  approvalDecisions: string[];
  monitoringDwellTimeMs?: number;
  rawEvents: OversightTelemetryEvent[];
}

export type ReplaySessionSummary = TracePlaybackSessionSummary;

function toOversightEvent(event: OversightTelemetryEvent): OversightEvent | null {
  const phase = typeof event.payload?.phase === 'string' ? event.payload.phase : '';
  const stepId = typeof event.payload?.stepId === 'string' ? event.payload.stepId : '';

  if (event.eventType === 'agent_action' && phase === 'tool_started') {
    return {
      kind: 'tool_started',
      timestamp: event.timestamp,
      stepId: stepId || `trace_step_${event.timestamp}`,
      toolName: typeof event.payload.toolName === 'string' ? event.payload.toolName : 'unknown_tool',
      toolInput: typeof event.payload.toolInput === 'string' ? event.payload.toolInput : '',
      focusType: event.payload.focusType || 'none',
      focusLabel: typeof event.payload.focusLabel === 'string' ? event.payload.focusLabel : 'Focus updated',
    };
  }

  if (event.eventType === 'agent_thinking') {
    const thinking = event.payload?.thinkingSummary;
    if (!thinking || typeof thinking.goal !== 'string') {
      return null;
    }
    return {
      kind: 'agent_thinking',
      timestamp: event.timestamp,
      stepId: stepId || `trace_step_${event.timestamp}`,
      toolName: typeof event.payload?.toolName === 'string' ? event.payload.toolName : undefined,
      thinking: thinking as AgentThinkingSummary,
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

function parseThinking(events: OversightTelemetryEvent[]): AgentThinkingSummary | null {
  const match = events.find((event) => event.eventType === 'agent_thinking');
  const thinking = match?.payload?.thinkingSummary;
  if (!thinking || typeof thinking.goal !== 'string') return null;
  return thinking as AgentThinkingSummary;
}

export function buildStepInspectionData(
  stepId: string,
  telemetryEvents: OversightTelemetryEvent[]
): StepInspectionData | null {
  const stepEvents = telemetryEvents.filter((event) => event.payload?.stepId === stepId);
  if (stepEvents.length === 0) return null;

  const started = stepEvents.find(
    (event) => event.eventType === 'agent_action' && event.payload?.phase === 'tool_started'
  );
  const toolName =
    (typeof started?.payload?.toolName === 'string' ? started.payload.toolName : undefined) ??
    (typeof stepEvents[0]?.payload?.toolName === 'string' ? stepEvents[0].payload.toolName : 'unknown_tool');
  const timestamp = started?.timestamp ?? stepEvents[0].timestamp;
  const thinking = parseThinking(stepEvents);

  const triggeredMechanisms = stepEvents
    .filter((event) => event.eventType === 'oversight_signal')
    .map((event) => String(event.payload?.phase || 'oversight_signal'));
  const parametersAtRuntime = (started?.payload ?? {}) as Record<string, unknown>;

  const humanEvents = stepEvents.filter((event) => event.source === 'human');
  const interventionActions = humanEvents
    .filter((event) => event.eventType === 'human_intervention')
    .map((event) => String(event.payload?.action || 'human_intervention'));
  const approvalDecisions = humanEvents
    .filter((event) => ['approval_accepted', 'approval_rejected'].includes(String(event.payload?.action || '')))
    .map((event) => String(event.payload?.action));
  const monitoringDwellTimeMs = humanEvents
    .filter((event) => event.eventType === 'human_monitoring')
    .map((event) => Number(event.payload?.dwellTimeMs))
    .find((value) => Number.isFinite(value));

  return {
    stepId,
    timestamp,
    toolName,
    goal: thinking?.goal ?? '',
    plan: thinking?.plan ?? [],
    memoryRead: thinking?.memoryRead ?? [],
    memoryWrite: thinking?.memoryWrite ?? [],
    rationale: thinking?.rationale ?? '',
    uncertainty: thinking?.uncertainty ?? 'unknown',
    riskFlags: thinking?.riskFlags ?? [],
    triggeredMechanisms,
    parametersAtRuntime,
    interventionActions,
    approvalDecisions,
    monitoringDwellTimeMs,
    rawEvents: stepEvents,
  };
}

export class TracePlaybackController {
  private sessionId: string | null = null;
  private traceEvents: OversightEvent[] = [];
  private telemetryEvents: OversightTelemetryEvent[] = [];
  private cursor = -1;

  async listSessions(): Promise<TracePlaybackSessionSummary[]> {
    const storage = await readStorage();
    const summaries: TracePlaybackSessionSummary[] = [];

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
    this.telemetryEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
    this.traceEvents = this.telemetryEvents
      .map(toOversightEvent)
      .filter((event): event is OversightEvent => event !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  stepForward(): void {
    if (this.cursor < this.traceEvents.length - 1) {
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
    for (let i = 0; i < this.traceEvents.length; i++) {
      if (this.traceEvents[i].timestamp <= timestamp) {
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

  getTraceEvents(): OversightEvent[] {
    return [...this.traceEvents];
  }

  getReplayEvents(): OversightEvent[] {
    return this.getTraceEvents();
  }

  getVisibleEvents(): OversightEvent[] {
    if (this.cursor < 0) return [];
    return this.traceEvents.slice(0, this.cursor + 1);
  }

  getCursor(): number {
    return this.cursor;
  }

  getStepSummaries(): TraceStepSummary[] {
    return this.traceEvents
      .filter((event): event is Extract<OversightEvent, { kind: 'tool_started' }> => event.kind === 'tool_started')
      .map((event) => ({
        stepId: event.stepId,
        timestamp: event.timestamp,
        toolName: event.toolName,
      }));
  }

  getCurrentStepId(): string | null {
    if (this.cursor < 0) return null;

    for (let i = this.cursor; i >= 0; i--) {
      const event = this.traceEvents[i];
      if (event.kind === 'tool_started' || event.kind === 'agent_thinking') {
        return event.stepId;
      }
    }

    return null;
  }

  jumpToStep(stepId: string): void {
    let idx = -1;
    for (let i = 0; i < this.traceEvents.length; i++) {
      const event = this.traceEvents[i];
      if ((event.kind === 'tool_started' || event.kind === 'agent_thinking') && event.stepId === stepId) {
        idx = i;
        break;
      }
    }
    this.cursor = idx;
  }

  getStepInspection(stepId: string): StepInspectionData | null {
    return buildStepInspectionData(stepId, this.telemetryEvents);
  }
}

export class ReplayController extends TracePlaybackController {}
