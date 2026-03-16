import React from 'react';

interface ApprovalRequestProps {
  requestId: string;
  toolName: string;
  toolInput: string;
  reason: string;
  onApprove: (requestId: string) => void;
  onApproveSeries?: (requestId: string) => void;
  onApproveSite?: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onDismiss: (requestId: string) => void;
  onEdit?: (requestId: string) => void;
  onRetry?: (requestId: string) => void;
  onRollback?: (requestId: string) => void;
  compact?: boolean;
  variant?: 'default' | 'action-confirmation' | 'supervisory' | 'supervisory-plan-step';
}

export function ApprovalRequest({ 
  requestId, 
  toolName, 
  toolInput, 
  reason, 
  onApprove, 
  onApproveSeries,
  onApproveSite,
  onReject,
  onDismiss,
  onEdit,
  onRetry,
  onRollback,
  compact = false,
  variant = 'default',
}: ApprovalRequestProps) {
  const isRiskGated = variant === 'default';
  const isActionConfirmation = variant === 'action-confirmation';
  const isSupervisory = variant === 'supervisory';
  const isSupervisoryPlanStep = variant === 'supervisory-plan-step';
  const isSupervisoryVariant = isSupervisory || isSupervisoryPlanStep;
  const quotedTarget = toolInput.match(/["']([^"']+)["']/)?.[1]?.trim();
  const nextActionLabel = quotedTarget || toolInput.trim() || toolName.replace(/^browser_/, '').replace(/_/g, ' ');
  const displayTitle = isActionConfirmation
    ? 'Needs Your Decision'
    : isSupervisoryPlanStep
      ? 'Accept Next Plan Step?'
      : isSupervisory
        ? 'Accept Next Action?'
      : 'Approval Required';
  const introText = isActionConfirmation
    ? 'The agent is ready to take the next action.'
    : isSupervisoryPlanStep
      ? 'The agent is about to move into the next part of the plan.'
      : isSupervisory
        ? 'The agent wants to take the next action for the current plan step.'
      : compact
      ? 'Critical action pending.'
      : 'The agent wants to execute a critical action:';

  return (
    <div
      className={`card border border-warning/25 bg-base-100 p-4 text-base-content shadow-lg my-2 ${
        isActionConfirmation
          ? 'max-h-[26rem]'
          : isSupervisoryPlanStep
            ? 'max-h-[42rem]'
            : isSupervisory
              ? 'max-h-[30rem]'
              : isRiskGated
                ? 'max-h-[58.5rem]'
                : ''
      }`}
    >
      <div className="flex items-start justify-between">
        <h3 className="font-bold">{displayTitle}</h3>
        {!isActionConfirmation && !isSupervisoryVariant ? (
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => onDismiss(requestId)}
            aria-label="Dismiss warning"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-base-content/75">{introText}</p>
      <div
        className={`mt-3 rounded-2xl border border-base-300 bg-base-200/70 p-3 ${
          isActionConfirmation
            ? 'max-h-64 overflow-y-auto'
            : isSupervisoryPlanStep
              ? 'max-h-[25.2rem] overflow-y-auto'
              : isSupervisory
              ? 'max-h-72 overflow-y-auto'
              : isRiskGated
                ? 'max-h-[46.5rem] overflow-y-auto'
              : ''
        }`}
      >
        {isActionConfirmation || isSupervisoryVariant ? (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-base-content/45">
              {isSupervisoryPlanStep ? 'Next Plan Step' : 'Next Action'}
            </div>
            <p className="mt-1 text-sm font-medium text-base-content">
              {nextActionLabel}
            </p>
            {reason ? <p className="mt-2 text-sm leading-6 text-base-content/80">{reason}</p> : null}
          </>
        ) : (
          <>
            <p><strong>Tool:</strong> {toolName}</p>
            {!compact ? <p><strong>Input:</strong> {toolInput}</p> : null}
            {reason && <p><strong>Reason:</strong> {reason}</p>}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2 justify-end mt-2">
        {onEdit ? (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => onEdit(requestId)}
          >
            Edit
          </button>
        ) : null}
        {onRetry ? (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => onRetry(requestId)}
          >
            Retry
          </button>
        ) : null}
        {onRollback ? (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => onRollback(requestId)}
          >
            Rollback
          </button>
        ) : null}
        <button 
          className="btn btn-error" 
          onClick={() => onReject(requestId)}
        >
          {isActionConfirmation ? 'Decline' : isSupervisoryVariant ? 'Reject' : 'Reject'}
        </button>
        {onApproveSeries ? (
          <div
            className="tooltip tooltip-bottom"
            data-tip="Approve similar actions on this page"
          >
            <button
              className="btn btn-info"
              onClick={() => onApproveSeries(requestId)}
            >
              Approve Similar
            </button>
          </div>
        ) : null}
        <button 
          className="btn btn-success" 
          onClick={() => onApprove(requestId)}
        >
          {isActionConfirmation ? 'Agree' : isSupervisoryVariant ? 'Accept' : 'Approve'}
        </button>
        {onApproveSite ? (
          <button
            className="btn btn-outline"
            onClick={() => onApproveSite(requestId)}
          >
            Always allow this site
          </button>
        ) : null}
      </div>
    </div>
  );
}
