import { faRobot } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React, { useEffect, useState } from 'react';
import type { StepImpact } from '../../oversight/types';
import { buildContextualRiskExplanation } from '../../oversight/riskAssessment';
import { badgeClassName, badgeVariants } from './badgeStyles';

export type TaskNodeStatus = 'active' | 'completed' | 'cancelled' | 'error';

export interface TaskNode {
  id: string;
  stepId: string;
  toolName: string;
  focusLabel: string;
  planStepIndex?: number;
  stepDescription?: string;
  thinking?: string;
  status: TaskNodeStatus;
  timestamp: number;
  intervention?: {
    impact: StepImpact;
    impactSource?: 'llm' | 'heuristic';
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

type TooltipKind = 'thinking' | 'risk';
type TooltipPlacement = 'above' | 'below';

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
  onThinkingTooltipVisibilityChange?: (rect: Pick<DOMRect, 'top' | 'bottom'> | null) => void;
}

const statusColorMap: Record<TaskNodeStatus, string> = {
  active: 'bg-blue-500',
  completed: 'bg-green-500',
  cancelled: 'bg-amber-500',
  error: 'bg-red-500',
};

const riskBadgeMap: Record<StepImpact, string> = {
  low: badgeVariants.success,
  medium: badgeVariants.warning,
  high: badgeVariants.danger,
};

const riskBadgeStyleMap: Record<StepImpact, React.CSSProperties> = {
  low: {
    borderColor: '#86efac',
    backgroundColor: '#f0fdf4',
    color: '#166534',
  },
  medium: {
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
    color: '#b45309',
  },
  high: {
    borderColor: '#fda4af',
    backgroundColor: '#fff1f2',
    color: '#be123c',
  },
};

const tooltipCardClassName =
  'absolute right-0 z-20 rounded-2xl border border-slate-200 bg-white p-3 text-slate-700 shadow-xl';

function formatToolName(toolName: string): string {
  if (!toolName) return toolName;
  return toolName.startsWith('browser_') ? toolName.slice('browser_'.length) : toolName;
}

function toTitleCasePhrase(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compactPhrase(text: string, maxWords = 7): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, maxWords);
  const joined = words.join(' ').trim();
  return joined.length > 52 ? `${joined.slice(0, 49).trim()}...` : joined;
}

function ensureSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const capped =
    normalized.split(/\s+/).length > 12
      ? normalized.split(/\s+/).slice(0, 12).join(' ')
      : normalized;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function compactSentence(text: string, maxLength = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trim()}...` : normalized;
}

function normalizeExplanationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function canonicalizeExplanationSentence(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bvisible text read\b/g, 'the page')
    .replace(/\bno input\b/g, '')
    .replace(/click target:\s*/g, '')
    .replace(/\bshould not change [a-z\s"]+\b/g, 'should not change the page')
    .replace(/\bonly reads the [a-z\s"]+\b/g, 'only reads the page')
    .replace(/["']/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeExplanationSentence(text: string): Set<string> {
  return new Set(
    canonicalizeExplanationSentence(text)
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function areNearDuplicateExplanationSentences(a: string, b: string): boolean {
  const canonicalA = canonicalizeExplanationSentence(a);
  const canonicalB = canonicalizeExplanationSentence(b);
  if (!canonicalA || !canonicalB) return false;
  if (canonicalA === canonicalB) return true;
  if (canonicalA.includes(canonicalB) || canonicalB.includes(canonicalA)) return true;

  const tokensA = tokenizeExplanationSentence(a);
  const tokensB = tokenizeExplanationSentence(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const overlap = intersection / Math.max(tokensA.size, tokensB.size);
  return overlap >= 0.7;
}

function mergeUniqueExplanationText(parts: string[]): string {
  const merged: string[] = [];

  for (const part of parts) {
    const sentences = normalizeExplanationText(part)
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (!sentence) continue;
      if (merged.some((existing) => areNearDuplicateExplanationSentences(existing, sentence))) continue;
      merged.push(sentence);
    }
  }

  return merged.join(' ');
}

function extractQuotedTarget(text: string): string | undefined {
  return Array.from(text.matchAll(/["']([^"']+)["']/g))
    .map((match) => match[1].trim())
    .find(Boolean);
}

function cleanActionPhrase(text: string): string {
  return text
    .replace(/^i(?:'m| am)\s+(?:going to|about to)\s+/i, '')
    .replace(/^i\s+(?:will|want to|need to|should)\s+/i, '')
    .replace(/^the agent\s+(?:will|wants to|needs to)\s+/i, '')
    .replace(/(?:\s+because|\s+so that|\s+to help|\s+in order to)\b[\s\S]*$/i, '')
    .replace(/\b(right now|now|next)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/g, '');
}

function buildFallbackPhrase(node: TaskNode): string {
  const tool = formatToolName(node.toolName).toLowerCase();
  const source = `${node.thinking || ''} ${node.focusLabel || ''}`.trim();
  const quotedTarget = extractQuotedTarget(source);
  const target =
    quotedTarget ||
    source
      .replace(/^i(?:'m| am)\s+/i, '')
      .replace(/^i\s+(?:will|want to|need to)\s+/i, '')
      .replace(/\b(scroll down|find|locate|open|fill out|fill|type|click|check|scan)\b/gi, ' ')
      .replace(/\b(the|a|an|section|button|form|page|target|area)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  if (tool.includes('snapshot') || tool.includes('query') || tool.includes('read')) {
    return quotedTarget ? `Scan ${quotedTarget}` : `Scan ${target || 'the page'}`;
  }
  if (tool.includes('click')) {
    return quotedTarget ? `Open ${quotedTarget}` : `Click ${target || 'the target'}`;
  }
  if (tool.includes('type') || tool.includes('fill')) {
    return quotedTarget ? `Fill ${quotedTarget}` : `Fill ${target || 'the field'}`;
  }
  if (tool.includes('navigate')) {
    return quotedTarget ? `Open ${quotedTarget}` : `Open the next page`;
  }
  return `Check ${target || 'the next step'}`;
}

function summarizeStepTitle(node: TaskNode): string {
  const source = (node.thinking || node.focusLabel || '').trim();
  const primarySentence =
    source
      .split(/(?<=[.!?])\s+/)
      .map((part) => cleanActionPhrase(part))
      .find((part) => part.length > 6) || '';

  const basePhrase = primarySentence || cleanActionPhrase(node.focusLabel || '') || buildFallbackPhrase(node);
  return ensureSentence(compactPhrase(toTitleCasePhrase(basePhrase), 10));
}

function getRiskExplanationText(node: TaskNode): string {
  if (!node.intervention) return '';
  const contextual = buildContextualRiskExplanation({
    toolName: node.toolName,
    toolInput: node.focusLabel,
    impact: node.intervention.impact,
    reversible: node.intervention.reversible,
    category: node.intervention.category,
    stepDescription: node.stepDescription || node.thinking,
  });
  const rationale = (node.intervention.reasonText || '').trim();
  if (!rationale) return contextual;
  if (rationale.includes('Input suggests') || rationale.includes('Interactive tool can modify page state')) {
    return contextual;
  }
  return mergeUniqueExplanationText([contextual, rationale]);
}

export const TaskExecutionGraph: React.FC<TaskExecutionGraphProps> = ({
  nodes,
  contentGranularity = 'step',
  colorEncoding = 'semantic',
  monitoringContentScope = 'full',
  onRiskLabelHover,
  onThinkingTooltipVisibilityChange,
}) => {
  const [activeTooltip, setActiveTooltip] = useState<{
    stepId: string;
    kind: TooltipKind;
    placement: TooltipPlacement;
  } | null>(null);

  useEffect(() => {
    if (!onThinkingTooltipVisibilityChange) return;
    if (activeTooltip?.kind !== 'thinking') {
      onThinkingTooltipVisibilityChange(null);
      return;
    }

    const tooltip = document.querySelector('[data-thinking-tooltip="active"]');
    if (!(tooltip instanceof HTMLElement)) {
      onThinkingTooltipVisibilityChange(null);
      return;
    }

    const rect = tooltip.getBoundingClientRect();
    onThinkingTooltipVisibilityChange({ top: rect.top, bottom: rect.bottom });
  }, [activeTooltip, onThinkingTooltipVisibilityChange]);

  const resolveTooltipPlacement = (element: HTMLElement): TooltipPlacement => {
    const rect = element.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    return spaceBelow < 220 && spaceAbove > spaceBelow ? 'above' : 'below';
  };

  const getTooltipPositionClasses = (placement: TooltipPlacement): string =>
    placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2';

  const openTooltip = (stepId: string, kind: TooltipKind, element: HTMLElement) => {
    setActiveTooltip({
      stepId,
      kind,
      placement: resolveTooltipPlacement(element),
    });
  };

  const toggleTooltip = (stepId: string, kind: TooltipKind, element: HTMLElement) => {
    setActiveTooltip((current) => {
      if (current?.stepId === stepId && current.kind === kind) return null;
      return {
        stepId,
        kind,
        placement: resolveTooltipPlacement(element),
      };
    });
  };

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
          const intervention = node.intervention;
          const showThinkingTooltip = activeTooltip?.stepId === node.stepId && activeTooltip.kind === 'thinking';
          const showRiskTooltip = activeTooltip?.stepId === node.stepId && activeTooltip.kind === 'risk';
          const tooltipPositionClasses = getTooltipPositionClasses(activeTooltip?.placement || 'below');
          const showRiskBadge = Boolean(intervention);
          const showRiskDetails = Boolean(intervention) && monitoringContentScope !== 'minimal';

          return (
            <div
              key={node.id}
              className="relative rounded px-1 py-1 hover:bg-base-200"
              onMouseEnter={(e) => {
                if (node.thinking) {
                  openTooltip(node.stepId, 'thinking', e.currentTarget);
                }
              }}
              onMouseLeave={() => {
                setActiveTooltip((current) => (current?.stepId === node.stepId ? null : current));
              }}
              onClick={(e) => {
                if (!node.thinking) return;
                toggleTooltip(node.stepId, 'thinking', e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (!node.thinking) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                toggleTooltip(node.stepId, 'thinking', e.currentTarget);
              }}
              onFocus={(e) => {
                if (!node.thinking) return;
                openTooltip(node.stepId, 'thinking', e.currentTarget);
              }}
              onBlur={() => {
                setActiveTooltip((current) => (current?.stepId === node.stepId ? null : current));
              }}
              role={node.thinking ? 'button' : undefined}
              tabIndex={node.thinking ? 0 : undefined}
            >
              <div className="group flex w-full items-start gap-2 text-left">
                <div className="relative flex w-5 justify-center">
                  <span className={`mt-1 block h-2.5 w-2.5 rounded-full ${statusClasses[node.status]}`} />
                  {!isLast ? <span className="absolute top-4 h-5 w-px bg-base-300" /> : null}
                </div>
                <div className="relative min-w-0 flex-1">
                  <div className="inline-flex max-w-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium text-base-content">
                        {summarizeStepTitle(node)}
                      </div>
                      {showRiskBadge ? (
                        <div
                          className="inline-flex"
                          onMouseEnter={(e) => {
                            if (!showRiskDetails) return;
                            openTooltip(node.stepId, 'risk', e.currentTarget);
                          }}
                          onMouseLeave={() => {
                            if (!showRiskDetails) return;
                            setActiveTooltip((current) =>
                              current?.stepId === node.stepId && current.kind === 'risk' ? null : current
                            );
                            onRiskLabelHover?.(0);
                          }}
                          onClick={(e) => {
                            if (!showRiskDetails) return;
                            e.stopPropagation();
                            toggleTooltip(node.stepId, 'risk', e.currentTarget);
                          }}
                        >
                          <span
                            className={`${badgeClassName()} ${riskBadgeMap[intervention!.impact]} ${showRiskDetails ? 'cursor-help' : ''}`}
                            style={riskBadgeStyleMap[intervention!.impact]}
                          >
                            risk: {intervention!.impact}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {node.thinking ? (
                    <div className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-base-content/70">
                      <FontAwesomeIcon icon={faRobot} className="mt-0.5 text-[11px] text-base-content/45" />
                      <span>{compactSentence(node.thinking)}</span>
                    </div>
                  ) : null}
                  {showThinkingTooltip && node.thinking ? (
                    <div
                      data-thinking-tooltip="active"
                      className={`pointer-events-none w-64 ${tooltipCardClassName} ${tooltipPositionClasses}`}
                      style={{ maxWidth: 'calc(100vw - 2rem)' }}
                    >
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Agent Thinking
                      </div>
                      <div className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                        <FontAwesomeIcon icon={faRobot} className="mt-0.5 text-[11px] text-slate-400" />
                        <span>{node.thinking}</span>
                      </div>
                    </div>
                  ) : null}
                  {showRiskDetails && showRiskTooltip ? (
                    <div
                      className={`pointer-events-none w-64 ${tooltipCardClassName} ${tooltipPositionClasses}`}
                      style={{ maxWidth: 'calc(100vw - 2rem)' }}
                    >
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Risk Explanation
                      </div>
                      <div className="text-xs leading-5 text-slate-700">
                        {getRiskExplanationText(node)}
                      </div>
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
