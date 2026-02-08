import React, { useEffect, useRef, useState } from 'react';

export type TaskNodeStatus = 'active' | 'completed' | 'cancelled' | 'error';

export interface TaskNode {
  id: string;
  toolName: string;
  focusLabel: string;
  thinking?: string;
  status: TaskNodeStatus;
  timestamp: number;
}

interface TaskExecutionGraphProps {
  nodes: TaskNode[];
  expanded: boolean;
  onToggle: () => void;
}

const statusColorMap: Record<TaskNodeStatus, string> = {
  active: 'bg-blue-500',
  completed: 'bg-green-500',
  cancelled: 'bg-amber-500',
  error: 'bg-red-500',
};

export const TaskExecutionGraph: React.FC<TaskExecutionGraphProps> = ({ nodes, expanded, onToggle }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  const isNearBottom = (el: HTMLDivElement) => {
    const threshold = 24;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  };

  useEffect(() => {
    if (!expanded) return;
    const list = listRef.current;
    if (!list || !autoScrollEnabled) return;
    list.scrollTop = list.scrollHeight;
  }, [nodes, expanded, autoScrollEnabled]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    setAutoScrollEnabled(isNearBottom(list));
  };

  if (nodes.length === 0) return null;

  return (
    <div className="border-b border-base-300 bg-base-100 px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
          Task Graph ({nodes.length})
        </div>
        <button className="btn btn-ghost btn-xs" onClick={onToggle}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {!expanded ? null : (
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="max-h-40 space-y-2 overflow-y-auto pr-1"
      >
        {nodes.map((node, idx) => {
          const isLast = idx === nodes.length - 1;
          return (
            <div key={node.id} className="group relative flex items-start gap-2 rounded px-1 py-1 hover:bg-base-200">
              <div className="relative flex w-5 justify-center">
                <span className={`mt-1 block h-2.5 w-2.5 rounded-full ${statusColorMap[node.status]}`} />
                {!isLast ? <span className="absolute top-4 h-5 w-px bg-base-300" /> : null}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-base-content">{node.toolName}</div>
                <div className="truncate text-xs text-base-content/70">{node.focusLabel}</div>
              </div>
              {node.thinking ? (
                <div className="pointer-events-none absolute left-4 top-full z-10 mt-1 hidden max-w-xs rounded border border-base-300 bg-base-100 p-2 text-xs text-base-content shadow-lg group-hover:block">
                  <div className="mb-1 font-semibold text-base-content/80">Thinking</div>
                  <div className="max-h-28 overflow-y-auto whitespace-pre-wrap">{node.thinking}</div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
};
