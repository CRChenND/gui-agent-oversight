import React from 'react';

interface AgentAttentionBarProps {
  state: 'active' | 'idle';
  toolName: string | null;
  focusLabel: string;
  updatedAt: number;
}

export const AgentAttentionBar: React.FC<AgentAttentionBarProps> = ({
  state,
  toolName,
  focusLabel,
  updatedAt
}) => {
  const isActive = state === 'active';
  const timeText = new Date(updatedAt).toLocaleTimeString();

  return (
    <div className="border-b border-base-300 bg-base-100 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className={`badge badge-sm ${isActive ? 'badge-error' : 'badge-ghost'}`}>
          {isActive ? 'Agent Focus' : 'Agent Idle'}
        </span>
        <span className="text-base-content/70">Updated {timeText}</span>
      </div>
      <div className="mt-1 text-base-content">
        {toolName ? <span className="font-semibold">{toolName}</span> : <span className="font-semibold">-</span>}
        <span className="mx-2 text-base-content/50">|</span>
        <span>{focusLabel}</span>
      </div>
    </div>
  );
};
