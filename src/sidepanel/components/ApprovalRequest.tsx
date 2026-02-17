import React from 'react';

interface ApprovalRequestProps {
  requestId: string;
  toolName: string;
  toolInput: string;
  reason: string;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onDismiss: (requestId: string) => void;
  onEdit?: (requestId: string) => void;
  onRetry?: (requestId: string) => void;
  onRollback?: (requestId: string) => void;
  compact?: boolean;
}

export function ApprovalRequest({ 
  requestId, 
  toolName, 
  toolInput, 
  reason, 
  onApprove, 
  onReject,
  onDismiss,
  onEdit,
  onRetry,
  onRollback,
  compact = false,
}: ApprovalRequestProps) {
  return (
    <div className="card bg-warning text-warning-content p-4 my-2">
      <div className="flex items-start justify-between">
        <h3 className="font-bold">Approval Required</h3>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => onDismiss(requestId)}
          aria-label="Dismiss warning"
        >
          Dismiss
        </button>
      </div>
      <p>{compact ? 'Critical action pending.' : 'The agent wants to execute a critical action:'}</p>
      <div className="bg-base-300 p-2 my-2 rounded">
        <p><strong>Tool:</strong> {toolName}</p>
        {!compact ? <p><strong>Input:</strong> {toolInput}</p> : null}
        {reason && <p><strong>Reason:</strong> {reason}</p>}
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
          Reject
        </button>
        <button 
          className="btn btn-success" 
          onClick={() => onApprove(requestId)}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
