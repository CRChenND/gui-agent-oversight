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
  onPlanStepSave?: (requestId: string, text: string) => Promise<void> | void;
  onPlanStepReset?: (requestId: string) => Promise<void> | void;
  compact?: boolean;
  variant?: 'default' | 'action-confirmation' | 'supervisory' | 'supervisory-plan-step';
  originalPlanStepText?: string;
  planStepBusy?: boolean;
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
  onPlanStepSave,
  onPlanStepReset,
  compact = false,
  variant = 'default',
  originalPlanStepText,
  planStepBusy = false,
}: ApprovalRequestProps) {
  const isRiskGated = variant === 'default';
  const isActionConfirmation = variant === 'action-confirmation';
  const isSupervisory = variant === 'supervisory';
  const isSupervisoryPlanStep = variant === 'supervisory-plan-step';
  const isSupervisoryVariant = isSupervisory || isSupervisoryPlanStep;
  const quotedTarget = toolInput.match(/["']([^"']+)["']/)?.[1]?.trim();
  const nextActionLabel = quotedTarget || toolInput.trim() || toolName.replace(/^browser_/, '').replace(/_/g, ' ');
  const canEditPlanStep = isSupervisoryPlanStep && typeof onPlanStepSave === 'function';
  const [isEditingPlanStep, setIsEditingPlanStep] = React.useState(false);
  const [draftPlanStepText, setDraftPlanStepText] = React.useState(nextActionLabel);
  const currentPlanStepText = toolInput.trim() || nextActionLabel;
  const visibleActionText = isSupervisoryPlanStep ? currentPlanStepText : nextActionLabel;
  const normalizedCurrentPlanStepText = currentPlanStepText.trim();
  const normalizedOriginalPlanStepText = (originalPlanStepText || normalizedCurrentPlanStepText).trim();
  const hasUnsavedPlanStepChanges = draftPlanStepText.trim() !== normalizedCurrentPlanStepText;
  const hasModifiedPlanStep = normalizedCurrentPlanStepText !== normalizedOriginalPlanStepText;
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

  React.useEffect(() => {
    setDraftPlanStepText(currentPlanStepText);
  }, [currentPlanStepText]);

  React.useEffect(() => {
    if (planStepBusy) {
      setIsEditingPlanStep(false);
    }
  }, [planStepBusy]);

  const handlePlanStepSave = async () => {
    if (!onPlanStepSave) return;
    const normalizedDraft = draftPlanStepText.trim();
    if (!normalizedDraft || normalizedDraft === normalizedCurrentPlanStepText) {
      setDraftPlanStepText(currentPlanStepText);
      setIsEditingPlanStep(false);
      return;
    }
    await onPlanStepSave(requestId, normalizedDraft);
  };

  const handlePlanStepReset = async () => {
    setDraftPlanStepText(normalizedOriginalPlanStepText);
    setIsEditingPlanStep(false);
    if (hasModifiedPlanStep && onPlanStepReset) {
      await onPlanStepReset(requestId);
    }
  };

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
            {!isSupervisoryPlanStep ? (
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-base-content/45">
                {isSupervisory ? 'Next Action' : 'Next Action'}
              </div>
            ) : null}
            {canEditPlanStep && isEditingPlanStep ? (
              <div className="space-y-2">
                <textarea
                  autoFocus
                  className="textarea textarea-bordered min-h-[5rem] w-full resize-y text-sm leading-6"
                  value={draftPlanStepText}
                  onChange={(e) => setDraftPlanStepText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      void handlePlanStepSave();
                    } else if (e.key === 'Escape') {
                      void handlePlanStepReset();
                    }
                  }}
                  rows={3}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={planStepBusy}
                    onClick={() => {
                      void handlePlanStepReset();
                    }}
                    type="button"
                  >
                    Reset
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={planStepBusy || !draftPlanStepText.trim() || !hasUnsavedPlanStepChanges}
                    onClick={() => {
                      void handlePlanStepSave();
                    }}
                    type="button"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : canEditPlanStep ? (
              <>
                <button
                  className={`w-full rounded-lg px-0 text-left text-sm font-medium leading-6 text-base-content ${
                    canEditPlanStep ? 'cursor-text transition hover:text-primary' : ''
                  }`}
                  disabled={!canEditPlanStep || planStepBusy}
                  onDoubleClick={() => {
                    if (!canEditPlanStep || planStepBusy) return;
                    setDraftPlanStepText(currentPlanStepText);
                    setIsEditingPlanStep(true);
                  }}
                  type="button"
                >
                  {visibleActionText}
                </button>
                {canEditPlanStep ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-base-content/55">
                    <span>Double-click to edit this step.</span>
                    {hasModifiedPlanStep ? (
                      <button
                        className="btn btn-ghost btn-xs"
                        disabled={planStepBusy}
                        onClick={() => {
                          void handlePlanStepReset();
                        }}
                        type="button"
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm font-medium text-base-content">
                {visibleActionText}
              </p>
            )}
            {!isSupervisoryPlanStep && reason ? <p className="mt-2 text-sm leading-6 text-base-content/80">{reason}</p> : null}
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
          disabled={planStepBusy || (canEditPlanStep && isEditingPlanStep && hasUnsavedPlanStepChanges)}
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
