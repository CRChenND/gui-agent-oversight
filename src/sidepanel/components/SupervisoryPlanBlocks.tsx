import React from 'react';

interface SupervisoryActualStep {
  stepId: string;
  toolName: string;
  focusLabel: string;
  thinking?: string;
  stepDescription?: string;
  planStepIndex?: number;
  timestamp: number;
}

interface SupervisoryPlanBlocksProps {
  planSteps: string[];
  taskNodes: SupervisoryActualStep[];
  taskNodePlanIndices: Array<number | null>;
  visibleUntilIndex: number;
}

function compactExecutionLabel(node: SupervisoryActualStep): string {
  const stepDescription = (node.stepDescription || '').trim();
  if (stepDescription) {
    return stepDescription.replace(/\s+/g, ' ').trim();
  }

  const thinking = (node.thinking || '').trim();
  if (thinking) {
    const cleaned = thinking.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      return cleaned;
    }
  }

  const focus = (node.focusLabel || '').trim();
  if (focus) {
    const normalizedFocus = focus
      .replace(/^(Click|Type|Fill|Open|Select|Scan)\s+target:\s*/i, '')
      .replace(/^DOM focus area:\s*/i, '')
      .trim();
    if (normalizedFocus) {
      const words = normalizedFocus.split(/\s+/).filter(Boolean).slice(0, 8);
      return words.join(' ');
    }
  }

  return node.toolName.replace(/^browser_/, '').replace(/_/g, ' ');
}

export function SupervisoryPlanBlocks({
  planSteps,
  taskNodes,
  taskNodePlanIndices,
  visibleUntilIndex,
}: SupervisoryPlanBlocksProps) {
  if (planSteps.length === 0) return null;

  const boundedVisibleUntilIndex = Math.max(0, Math.min(visibleUntilIndex, planSteps.length - 1));
  const groupedNodes = planSteps.map((_, planIndex) =>
    taskNodes.filter((_, nodeIndex) => taskNodePlanIndices[nodeIndex] === planIndex)
  );

  return (
    <div className="space-y-3 px-3 pb-1 pt-3">
      {planSteps.slice(0, boundedVisibleUntilIndex + 1).map((step, index) => {
        const nodes = groupedNodes[index];

        return (
          <div
            key={`supervisory-plan-${index}`}
            className="rounded-3xl border border-base-300 bg-base-100 px-4 py-4 shadow-sm"
          >
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-base-content/45">
                Step {index + 1}
              </div>
              <div className="mt-1 text-sm font-medium leading-6 text-base-content">{step}</div>
            </div>

            <div className="mt-4 space-y-2">
              {nodes.length > 0 ? (
                nodes.map((node) => (
                  <div
                    key={`plan-node-${node.stepId}`}
                    className="rounded-2xl border border-base-200 bg-base-200/55 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-info" />
                      <span className="text-sm leading-6 text-base-content/85">{compactExecutionLabel(node)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-base-300 px-3 py-2 text-xs text-base-content/45">
                  This step has not started yet.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
