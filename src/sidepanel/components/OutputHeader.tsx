import { faCog, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React from 'react';

interface OutputHeaderProps {
  onOpenOptions: () => void;
  onClearHistory: () => void;
  isProcessing: boolean;
}

export const OutputHeader: React.FC<OutputHeaderProps> = ({
  onOpenOptions,
  onClearHistory,
  isProcessing
}) => {
  return (
    <div className="flex items-center gap-2">
        <div className="tooltip tooltip-bottom" data-tip="Open settings">
          <button
            onClick={onOpenOptions}
            className="btn btn-ghost btn-xs"
            disabled={isProcessing}
          >
            <FontAwesomeIcon icon={faCog} />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Clear conversation history and LLM context">
          <button 
            onClick={onClearHistory}
            className="btn btn-ghost btn-xs"
            disabled={isProcessing}
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
        </div>
    </div>
  );
};
