import React, { useEffect, useRef, useState } from 'react';
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
  };
}

interface TaskExecutionGraphProps {
  nodes: TaskNode[];
  contentGranularity?: 'task' | 'step' | 'substep';
  informationDensity?: 'compact' | 'balanced' | 'detailed';
  colorEncoding?: 'semantic' | 'monochrome' | 'high_contrast';
  monitoringContentScope?: 'minimal' | 'standard' | 'full';
  explanationAvailability?: 'none' | 'summary' | 'full';
  explanationFormat?: 'text' | 'snippet' | 'diff';
}

const statusColorMap: Record<TaskNodeStatus, string> = {
  active: 'bg-blue-500',
  completed: 'bg-green-500',
  cancelled: 'bg-amber-500',
  error: 'bg-red-500',
};

const impactBadgeMap: Record<StepImpact, string> = {
  low: 'badge badge-success badge-xs',
  medium: 'badge badge-warning badge-xs',
  high: 'badge badge-error badge-xs',
};

function decisionBadgeClass(decision: 'approve' | 'deny' | 'edit' | 'rollback'): string {
  if (decision === 'approve') return 'badge badge-success badge-xs';
  if (decision === 'deny') return 'badge badge-error badge-xs';
  if (decision === 'edit') return 'badge badge-warning badge-xs';
  return 'badge badge-info badge-xs';
}

export const TaskExecutionGraph: React.FC<TaskExecutionGraphProps> = ({
  nodes,
  contentGranularity = 'step',
  informationDensity = 'balanced',
  colorEncoding = 'semantic',
  monitoringContentScope = 'full',
  explanationAvailability = 'summary',
  explanationFormat = 'text',
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  const isNearBottom = (el: HTMLDivElement) => {
    const threshold = 24;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list || !autoScrollEnabled) return;
    list.scrollTop = list.scrollHeight;
  }, [nodes, autoScrollEnabled]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    setAutoScrollEnabled(isNearBottom(list));
  };

  if (nodes.length === 0) return null;

  const maxHeightClass =
    informationDensity === 'compact' ? 'max-h-56' : informationDensity === 'detailed' ? 'max-h-[24rem]' : 'max-h-72';
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
        <div className="text-xs font-semibold uppercase tracking-wide text-base-content/70">Task Graph</div>
        <div className="mt-1">steps: {nodes.length}</div>
        <div className="text-xs text-base-content/70">active: {active} | completed: {completed} | error: {errored}</div>
      </div>
    );
  }

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => ({
      ...prev,
      [stepId]: !prev[stepId],
    }));
  };

  const renderImpactExplanation = (node: TaskNode) => {
    if (!node.intervention) return null;
    const impact = node.intervention.impact;
    const source = node.intervention.impactSource || 'heuristic';
    const rationale = node.intervention.impactRationale || node.intervention.reasonText || '';

    if (explanationFormat === 'diff') {
      const heuristicLine = `- heuristic impact baseline: ${impact}`;
      const llmLine =
        source === 'llm'
          ? `+ llm-adjusted impact: ${impact}`
          : '+ llm-adjusted impact: (not provided)';
      return (
        <div className="mt-1 whitespace-pre-wrap font-mono">
          {heuristicLine}
          {'\n'}
          {llmLine}
          {rationale ? `\n+ rationale: ${rationale}` : ''}
        </div>
      );
    }

    if (explanationFormat === 'snippet') {
      const snippet = rationale ? rationale.slice(0, 140) : `impact=${impact} source=${source}`;
      return <div className="mt-1 whitespace-pre-wrap">{snippet}</div>;
    }

    return (
      <>
        <div>source: {source}</div>
        <div>impact: {impact}</div>
        {node.intervention.impactRationale && explanationAvailability === 'full' ? (
          <div className="whitespace-pre-wrap">rationale: {node.intervention.impactRationale}</div>
        ) : null}
        {node.intervention.reasonText && explanationAvailability === 'full' ? (
          <div className="mt-1 whitespace-pre-wrap">decision basis: {node.intervention.reasonText}</div>
        ) : null}
      </>
    );
  };

  return (
    <div className="border-b border-base-300 bg-base-100 px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
          Task Graph ({nodes.length})
        </div>
      </div>
      <div
        ref={listRef}
        onScroll={handleScroll}
        className={`${maxHeightClass} space-y-2 overflow-y-auto pr-1`}
      >
        {nodes.map((node, idx) => {
          const isLast = idx === nodes.length - 1;
          const isExpanded = Boolean(expandedSteps[node.stepId]);
          return (
            <div key={node.id} className="relative rounded px-1 py-1 hover:bg-base-200">
              <button
                className="group flex w-full items-start gap-2 text-left"
                onClick={() => toggleStep(node.stepId)}
              >
                <div className="relative flex w-5 justify-center">
                  <span className={`mt-1 block h-2.5 w-2.5 rounded-full ${statusClasses[node.status]}`} />
                  {!isLast ? <span className="absolute top-4 h-5 w-px bg-base-300" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-base-content">{node.toolName}</div>
                    <div className="text-[11px] text-base-content/50">{isExpanded ? 'Hide' : 'Show'}</div>
                  </div>
                  <div className="truncate text-xs text-base-content/70">{node.focusLabel}</div>
                  {node.intervention && monitoringContentScope !== 'minimal' ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className={impactBadgeMap[node.intervention.impact]}>impact: {node.intervention.impact}</span>
                      <span className={`badge badge-xs ${node.intervention.requiresApproval ? 'badge-warning' : 'badge-ghost'}`}>
                        approval: {node.intervention.requiresApproval ? 'yes' : 'no'}
                      </span>
                      {node.intervention.promptedByGate && monitoringContentScope === 'full' ? (
                        <span className="badge badge-xs badge-info">gate:{node.intervention.gatePolicy}</span>
                      ) : null}
                      {node.intervention.decision ? (
                        <span className={decisionBadgeClass(node.intervention.decision)}>
                          decision:{node.intervention.decision}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </button>

              {isExpanded && explanationAvailability !== 'none' && (node.thinking || node.intervention) ? (
                <div className="ml-7 mt-2 rounded border border-base-300 bg-base-200 p-2 text-xs text-base-content">
                  {node.thinking && monitoringContentScope !== 'minimal' ? (
                    <div className="mb-2">
                      <div className="mb-1 font-semibold text-base-content/80">Thinking</div>
                      <div className="whitespace-pre-wrap">
                        {explanationAvailability === 'summary' ? node.thinking.slice(0, 160) : node.thinking}
                      </div>
                    </div>
                  ) : null}
                  {node.intervention && monitoringContentScope !== 'minimal' ? (
                    <div>
                      <div className="mb-1 font-semibold text-base-content/80">Impact Assessment</div>
                      <div>format: {explanationFormat}</div>
                      {renderImpactExplanation(node)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
