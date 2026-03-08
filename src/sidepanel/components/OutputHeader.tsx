import { faCog, faDownload, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React from 'react';

interface OutputHeaderProps {
  onOpenOptions: () => void;
  onClearHistory: () => void;
  onDownloadTaskGraph: () => void;
  canDownloadTaskGraph: boolean;
  isProcessing: boolean;
}

export const OutputHeader: React.FC<OutputHeaderProps> = ({
  onOpenOptions,
  onClearHistory,
  onDownloadTaskGraph,
  canDownloadTaskGraph,
  isProcessing
}) => {
  return (
    <div className="flex items-center justify-between border-b border-base-300 px-3 py-2">
      <div className="text-sm font-semibold tracking-wide text-base-content/80">
        MORPH
      </div>
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
        <div className="tooltip tooltip-bottom" data-tip="Download current task graph steps as JSON">
          <button
            onClick={onDownloadTaskGraph}
            className="btn btn-ghost btn-xs"
            disabled={!canDownloadTaskGraph}
          >
            <FontAwesomeIcon icon={faDownload} />
          </button>
        </div>
      </div>
    </div>
  );
};
