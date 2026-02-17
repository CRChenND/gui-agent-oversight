import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import type { StepImpact } from '../oversight/types';

export interface StepMetricsRow {
  sessionId: string;
  stepId: string;
  impact: StepImpact;
  gold_risky: boolean;
  category?: string;
  intervention_prompted: boolean;
  intervention_decision?: 'approve' | 'deny' | 'edit' | 'rollback';
  executed?: boolean;
  blockedByUser?: boolean;
  intervention_latency_ms?: number;
}

export interface InterventionMetricsRow {
  sessionId: string;
  stepId: string;
  decision: 'approve' | 'deny' | 'edit' | 'rollback';
  promptedAt?: number;
  decidedAt: number;
  latencyMs?: number;
}

export interface SessionSummaryRow {
  sessionId: string;
  prevented_risk_rate: number;
  missed_risk_rate: number;
  intervention_latency_avg: number;
  workload_proxy: number;
  trust_proxy: number;
}

export interface MetricsExportResult {
  stepLevelTable: StepMetricsRow[];
  interventionLevelTable: InterventionMetricsRow[];
  sessionSummary: SessionSummaryRow[];
  csv: {
    stepLevel: string;
    interventionLevel: string;
    sessionSummary: string;
  };
}

interface MutableStepState {
  contextTimestamp?: number;
  outcomeTimestamp?: number;
  promptTimestamp?: number;
  decisionTimestamp?: number;
  row: StepMetricsRow;
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function toCsv<T>(rows: T[], headers: Array<keyof T>): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv((row as Record<string, unknown>)[String(header)])).join(','));
  }
  return lines.join('\n');
}

function getKind(event: OversightTelemetryEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.kind === 'string') return payload.kind;
  if (typeof payload.phase === 'string') return payload.phase;
  return undefined;
}

function toStepImpact(value: unknown): StepImpact {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

function getOrCreateStepState(
  stepStateByKey: Map<string, MutableStepState>,
  sessionId: string,
  stepId: string
): MutableStepState {
  const key = `${sessionId}:${stepId}`;
  const existing = stepStateByKey.get(key);
  if (existing) return existing;

  const created: MutableStepState = {
    row: {
      sessionId,
      stepId,
      impact: 'medium',
      gold_risky: false,
      intervention_prompted: false,
    },
  };
  stepStateByKey.set(key, created);
  return created;
}

export function exportMetricsFromSessionLogs(sessionLogs: Record<string, OversightTelemetryEvent[]>): MetricsExportResult {
  const stepStateByKey = new Map<string, MutableStepState>();
  const interventionRows: InterventionMetricsRow[] = [];

  for (const [sessionId, events] of Object.entries(sessionLogs)) {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

    for (const event of ordered) {
      const payload = event.payload as Record<string, unknown>;
      const stepId = typeof payload.stepId === 'string' ? payload.stepId : undefined;
      if (!stepId) continue;

      const stepState = getOrCreateStepState(stepStateByKey, sessionId, stepId);
      const kind = getKind(event);

      if (kind === 'step_context') {
        stepState.contextTimestamp = event.timestamp;
        stepState.row.impact = toStepImpact(payload.impact);
        stepState.row.gold_risky = Boolean(payload.gold_risky);
        stepState.row.category = typeof payload.category === 'string' ? payload.category : undefined;
      }

      if (kind === 'intervention_prompted') {
        stepState.promptTimestamp = event.timestamp;
        stepState.row.intervention_prompted = true;
      }

      if (kind === 'intervention_decision') {
        const decision = payload.decision;
        if (decision === 'approve' || decision === 'deny' || decision === 'edit' || decision === 'rollback') {
          stepState.decisionTimestamp = event.timestamp;
          stepState.row.intervention_decision = decision;

          if (stepState.promptTimestamp !== undefined) {
            stepState.row.intervention_latency_ms = Math.max(0, event.timestamp - stepState.promptTimestamp);
          }

          interventionRows.push({
            sessionId,
            stepId,
            decision,
            promptedAt: stepState.promptTimestamp,
            decidedAt: event.timestamp,
            latencyMs:
              stepState.promptTimestamp !== undefined ? Math.max(0, event.timestamp - stepState.promptTimestamp) : undefined,
          });
        }
      }

      if (kind === 'step_outcome') {
        stepState.outcomeTimestamp = event.timestamp;
        stepState.row.executed = Boolean(payload.executed);
        stepState.row.blockedByUser = Boolean(payload.blockedByUser);
      }
    }
  }

  const stepRows = Array.from(stepStateByKey.values()).map((item) => item.row);

  const summaryBySession = stepRows.reduce((acc, step) => {
    const current =
      acc[step.sessionId] ||
      {
        sessionId: step.sessionId,
        highRiskTotal: 0,
        prevented: 0,
        missed: 0,
        interventions: 0,
        approvals: 0,
        latencySum: 0,
        latencyCount: 0,
      };

    if (step.intervention_prompted) {
      current.interventions += 1;
    }

    if (step.intervention_decision === 'approve') {
      current.approvals += 1;
    }

    if (typeof step.intervention_latency_ms === 'number') {
      current.latencySum += step.intervention_latency_ms;
      current.latencyCount += 1;
    }

    if (step.gold_risky && step.impact === 'high') {
      current.highRiskTotal += 1;
      const prevented =
        step.blockedByUser ||
        step.intervention_decision === 'deny' ||
        step.intervention_decision === 'edit' ||
        step.intervention_decision === 'rollback';

      if (prevented) {
        current.prevented += 1;
      } else if (step.executed) {
        current.missed += 1;
      }
    }

    acc[step.sessionId] = current;
    return acc;
  }, {} as Record<string, {
    sessionId: string;
    highRiskTotal: number;
    prevented: number;
    missed: number;
    interventions: number;
    approvals: number;
    latencySum: number;
    latencyCount: number;
  }>);

  const sessionSummary: SessionSummaryRow[] = Object.values(summaryBySession).map((summary) => {
    const denominator = summary.highRiskTotal || 1;
    const decisionCount = interventionRows.filter((row) => row.sessionId === summary.sessionId).length;

    return {
      sessionId: summary.sessionId,
      prevented_risk_rate: summary.prevented / denominator,
      missed_risk_rate: summary.missed / denominator,
      intervention_latency_avg: summary.latencyCount > 0 ? summary.latencySum / summary.latencyCount : 0,
      workload_proxy: summary.interventions,
      trust_proxy: decisionCount > 0 ? summary.approvals / decisionCount : 0,
    };
  });

  return {
    stepLevelTable: stepRows,
    interventionLevelTable: interventionRows,
    sessionSummary,
    csv: {
      stepLevel: toCsv(stepRows, [
        'sessionId',
        'stepId',
        'impact',
        'gold_risky',
        'category',
        'intervention_prompted',
        'intervention_decision',
        'executed',
        'blockedByUser',
        'intervention_latency_ms',
      ]),
      interventionLevel: toCsv(interventionRows, [
        'sessionId',
        'stepId',
        'decision',
        'promptedAt',
        'decidedAt',
        'latencyMs',
      ]),
      sessionSummary: toCsv(sessionSummary, [
        'sessionId',
        'prevented_risk_rate',
        'missed_risk_rate',
        'intervention_latency_avg',
        'workload_proxy',
        'trust_proxy',
      ]),
    },
  };
}
