import { faDownload, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React from 'react';

interface OutputHeaderProps {
  onClearHistory: () => void;
  onDownloadTaskGraph: () => void;
  canDownloadTaskGraph: boolean;
  isProcessing: boolean;
}

export const OutputHeader: React.FC<OutputHeaderProps> = ({
  onClearHistory,
  onDownloadTaskGraph,
  canDownloadTaskGraph,
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
        <div className="tooltip tooltip-bottom" data-tip="Download current task graph steps as JSON">
          <button
            onClick={onDownloadTaskGraph}
            className="btn btn-sm btn-outline"
            disabled={!canDownloadTaskGraph}
          >
            <FontAwesomeIcon icon={faDownload} />
          </button>
        </div>
      </div>
    </div>
  );
};
