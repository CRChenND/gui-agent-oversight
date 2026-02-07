import { faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React from 'react';

interface OutputHeaderProps {
  onClearHistory: () => void;
  isProcessing: boolean;
}

export const OutputHeader: React.FC<OutputHeaderProps> = ({
  onClearHistory,
  isProcessing
}) => {
  return (
    <div className="flex justify-between items-center bg-base-300 p-3">
      <div className="card-title text-base-content text-lg">
        Demo
      </div>
      <div className="flex items-center gap-2">
        <div className="tooltip tooltip-bottom" data-tip="Clear conversation history and LLM context">
          <button 
            onClick={onClearHistory}
            className="btn btn-sm btn-outline"
            disabled={isProcessing}
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
        </div>
      </div>
    </div>
  );
};
