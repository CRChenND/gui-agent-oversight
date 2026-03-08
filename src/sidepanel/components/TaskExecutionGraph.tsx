import React, { useRef, useState } from 'react';
import type { StepImpact } from '../../oversight/types';

export type TaskNodeStatus = 'active' | 'completed' | 'cancelled' | 'error';

export interface TaskNode {
  id: string;
  stepId: string;
  toolName: string;
  focusLabel: string;
  thinking?: string;
  status: TaskNodeStatus;
  timestamp: number;
  intervention?: {
    impact: StepImpact;
    impactSource?: 'llm' | 'heuristic';
    impactRationale?: string;
    requiresApproval: boolean;
    llmRequiresApproval: boolean;
    promptedByGate: boolean;
    gatePolicy: string;
    adaptiveGateLevel: string;
    reasonText?: string;
    decision?: 'approve' | 'deny' | 'edit' | 'rollback';
    reversible?: boolean;
    category?: string;
    plannedNextStep?: string;
    plannedAlternative?: string;
    plannedRationale?: string;
    amplifiedRisk?: {
      effect_type: 'reversible' | 'irreversible';
      scope: 'local' | 'external';
      data_flow: 'disclosure' | 'none';
    } | null;
  };
}

type TooltipKind = 'thinking' | 'risk' | 'decision';

interface TaskExecutionGraphProps {
  nodes: TaskNode[];
  contentGranularity?: 'task' | 'step' | 'substep';
  informationDensity?: 'compact' | 'balanced' | 'detailed';
  colorEncoding?: 'semantic' | 'monochrome' | 'high_contrast';
  monitoringContentScope?: 'minimal' | 'standard' | 'full';
  explanationAvailability?: 'none' | 'summary' | 'full';
  explanationFormat?: 'text' | 'snippet' | 'diff';
  onTraceNodeExpanded?: (stepId: string) => void;
  onRepeatedTraceExpansion?: () => void;
  onRepeatedScrollBackward?: () => void;
  onRiskLabelHover?: (durationMs: number) => void;
}

const statusColorMap: Record<TaskNodeStatus, string> = {
  active: 'bg-blue-500',
  completed: 'bg-green-500',
  cancelled: 'bg-amber-500',
  error: 'bg-red-500',
};

const riskBadgeMap: Record<StepImpact, string> = {
  low: 'badge badge-success badge-xs',
  medium: 'badge badge-warning badge-xs',
  high: 'badge badge-error badge-xs',
};

const decisionBadgeMap: Record<'approve' | 'deny' | 'edit' | 'rollback', string> = {
  approve: 'badge badge-success badge-xs',
  deny: 'badge badge-error badge-xs',
  edit: 'badge badge-warning badge-xs',
  rollback: 'badge badge-info badge-xs',
};

function formatToolName(toolName: string): string {
  if (!toolName) return toolName;
  return toolName.startsWith('browser_') ? toolName.slice('browser_'.length) : toolName;
}

function summarizeStepTitle(node: TaskNode): string {
  const source = `${node.thinking || ''} ${node.focusLabel || ''}`.trim();
  const quoted = Array.from(source.matchAll(/["']([^"']+)["']/g))
    .map((match) => match[1].trim())
    .filter(Boolean);

  const tool = formatToolName(node.toolName).toLowerCase();
  const verb =
    tool.includes('snapshot') || tool.includes('query') || tool.includes('read')
      ? 'Scan'
      : tool.includes('click')
        ? 'Open'
        : tool.includes('type') || tool.includes('fill')
          ? 'Fill'
          : tool.includes('navigate')
            ? 'Open'
            : 'Check';

  const rawEntity =
    quoted[0] ||
    source
      .replace(/^i(?:'m| am)\s+/i, '')
      .replace(/^i\s+will\s+/i, '')
      .replace(/^i\s+need\s+to\s+/i, '')
      .replace(/^now\s+/i, '')
      .replace(/\b(scroll down|find|locate|open|fill out|fill|type|click|check|scan)\b/gi, '')
      .replace(/\b(the|a|an|section|button|form|page|target|area)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const entityWords = rawEntity
    .replace(/[^\w\s"-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);

  const entity = entityWords.length > 0 ? entityWords.join(' ') : 'next step';
  const title = `${verb} ${entity}`;
  const compact = title.split(/\s+/).slice(0, 6).join(' ');
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

function getRiskExplanationText(node: TaskNode): string {
  if (!node.intervention) return '';
  const rationale = node.intervention.impactRationale || node.intervention.reasonText || '';
  if (rationale.trim()) return rationale.trim();
  if (node.intervention.impact === 'low') {
    return 'This step is low risk because it mainly observes the page or changes something easy to undo.';
  }
  if (node.intervention.impact === 'medium') {
    return 'This step is medium risk because it changes page state, but the impact is still limited and usually reversible.';
  }
  return 'This step is high risk because it could cause a meaningful action, external effect, or hard-to-undo change.';
}

function getDecisionExplanationText(node: TaskNode): string {
  if (!node.intervention) return '';
  return (
    node.intervention.reasonText ||
    node.intervention.impactRationale ||
    'This step asked for a user decision because it could meaningfully affect the task or page state.'
  );
}

export const TaskExecutionGraph: React.FC<TaskExecutionGraphProps> = ({
  nodes,
  contentGranularity = 'step',
  colorEncoding = 'semantic',
  monitoringContentScope = 'full',
  onRiskLabelHover,
}) => {
  const hoverStartByStepRef = useRef<Record<string, number>>({});
  const [activeTooltip, setActiveTooltip] = useState<{
    stepId: string;
    kind: TooltipKind;
  } | null>(null);

  if (nodes.length === 0) return null;
  const statusClasses: Record<TaskNodeStatus, string> =
    colorEncoding === 'monochrome'
      ? {
          active: 'bg-base-content',
          completed: 'bg-base-content/70',
          cancelled: 'bg-base-content/50',
          error: 'bg-base-content/90',
        }
      : colorEncoding === 'high_contrast'
        ? {
            active: 'bg-cyan-400',
            completed: 'bg-lime-400',
            cancelled: 'bg-yellow-400',
            error: 'bg-rose-500',
          }
        : statusColorMap;

  if (contentGranularity === 'task') {
    const completed = nodes.filter((n) => n.status === 'completed').length;
    const active = nodes.filter((n) => n.status === 'active').length;
    const errored = nodes.filter((n) => n.status === 'error').length;
    return (
      <div className="border-b border-base-300 bg-base-100 px-3 py-2 text-sm">
        <div className="mt-1">steps: {nodes.length}</div>
        <div className="text-xs text-base-content/70">active: {active} | completed: {completed} | error: {errored}</div>
      </div>
    );
  }

  return (
    <div className="bg-base-100 px-3 py-2">
      <div className="space-y-2">
        {nodes.map((node, idx) => {
          const isLast = idx === nodes.length - 1;
          const showThinkingTooltip = activeTooltip?.stepId === node.stepId && activeTooltip.kind === 'thinking';
          const showRiskTooltip = activeTooltip?.stepId === node.stepId && activeTooltip.kind === 'risk';
          const showDecisionTooltip = activeTooltip?.stepId === node.stepId && activeTooltip.kind === 'decision';

          return (
            <div
              key={node.id}
              className="relative rounded px-1 py-1 hover:bg-base-200"
              onMouseEnter={() => {
                if (node.thinking) {
                  setActiveTooltip({ stepId: node.stepId, kind: 'thinking' });
                }
              }}
              onMouseLeave={() => {
                setActiveTooltip((current) => (current?.stepId === node.stepId ? null : current));
              }}
            >
              <div className="group flex w-full items-start gap-2 text-left">
                <div className="relative flex w-5 justify-center">
                  <span className={`mt-1 block h-2.5 w-2.5 rounded-full ${statusClasses[node.status]}`} />
                  {!isLast ? <span className="absolute top-4 h-5 w-px bg-base-300" /> : null}
                </div>
                <div className="relative min-w-0 flex-1">
                  <div className="inline-flex max-w-full">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-base-content">
                        {summarizeStepTitle(node)}
                      </div>
                    </div>
                  </div>
                  {showThinkingTooltip && node.thinking ? (
                    <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-72 rounded-2xl border border-base-300 bg-gradient-to-br from-base-100 to-base-200 p-3 shadow-xl">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/50">
                        Agent Thinking
                      </div>
                      <div className="text-xs leading-5 text-base-content/80">
                        {node.thinking}
                      </div>
                    </div>
                  ) : null}
                  {node.intervention && monitoringContentScope !== 'minimal' ? (
                    <div className="relative mt-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <div
                          className="inline-flex"
                          onMouseEnter={() => {
                            setActiveTooltip({ stepId: node.stepId, kind: 'risk' });
                            hoverStartByStepRef.current[node.stepId] = Date.now();
                          }}
                          onMouseLeave={() => {
                            setActiveTooltip((current) =>
                              current?.stepId === node.stepId && current.kind === 'risk' ? null : current
                            );
                            const startedAt = hoverStartByStepRef.current[node.stepId];
                            if (!startedAt) return;
                            delete hoverStartByStepRef.current[node.stepId];
                            const durationMs = Date.now() - startedAt;
                            if (durationMs > 0) {
                              onRiskLabelHover?.(durationMs);
                            }
                          }}
                        >
                          <span className={riskBadgeMap[node.intervention.impact]}>
                            risk: {node.intervention.impact}
                          </span>
                        </div>
                        {node.intervention.decision ? (
                          <div
                            className="inline-flex"
                            onMouseEnter={() => {
                              setActiveTooltip({ stepId: node.stepId, kind: 'decision' });
                            }}
                            onMouseLeave={() => {
                              setActiveTooltip((current) =>
                                current?.stepId === node.stepId && current.kind === 'decision' ? null : current
                              );
                            }}
                          >
                            <span className={`${decisionBadgeMap[node.intervention.decision]} cursor-help`}>
                              decision:{node.intervention.decision}
                            </span>
                          </div>
                        ) : null}
                      </div>
                      {showRiskTooltip ? (
                        <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-64 rounded-2xl border border-base-300 bg-gradient-to-br from-base-100 to-base-200 p-3 shadow-xl">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/50">
                            Risk Explanation
                          </div>
                          <div className="text-xs leading-5 text-base-content/80">
                            {getRiskExplanationText(node)}
                          </div>
                        </div>
                      ) : null}
                      {showDecisionTooltip ? (
                        <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-64 rounded-2xl border border-base-300 bg-gradient-to-br from-base-100 to-base-200 p-3 shadow-xl">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/50">
                            Decision Context
                          </div>
                          <div className="text-xs leading-5 text-base-content/80">
                            {getDecisionExplanationText(node)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
