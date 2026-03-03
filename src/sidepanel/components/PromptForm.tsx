import { faPaperPlane, faXmark } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React, { useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';

interface PromptFormProps {
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
  onPause?: () => void;
  onResume?: () => void;
  isProcessing: boolean;
  canPause?: boolean;
  canResume?: boolean;
  tabStatus: 'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error';
}

export const PromptForm: React.FC<PromptFormProps> = ({
  onSubmit,
  onCancel,
  onPause,
  onResume,
  isProcessing,
  canPause = false,
  canResume = false,
  tabStatus
}) => {
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isProcessing || tabStatus === 'detached') return;
    onSubmit(prompt);
    setPrompt(''); // Clear the prompt after submission
  };

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div className="morph-composer w-full bg-base-100">
        <TextareaAutosize
          className="textarea textarea-ghost w-full pr-40 text-sm focus:outline-none"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Check if Enter was pressed without Shift key
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault(); // Prevent default behavior (new line)
              handleSubmit(e); // Submit the form
            }
            // Allow Shift+Enter to create a new line (default behavior)
          }}
          placeholder={tabStatus === 'detached' 
            ? "Tab connection lost. Please refresh the tab to continue." 
            : "Type a message..."}
          autoFocus
          disabled={isProcessing || tabStatus === 'detached'}
          minRows={1}
          maxRows={10}
          style={{ 
            resize: 'none',
            minHeight: '44px',
            maxHeight: '220px',
            overflow: 'auto'
          } as any}
        />
        {isProcessing ? (
          <div className="absolute flex gap-1" style={{ bottom: '8px', right: '8px' }}>
            {canPause ? (
              <button type="button" onClick={onPause} className="btn btn-xs btn-outline" title="Pause">
                Pause
              </button>
            ) : null}
            {canResume ? (
              <button type="button" onClick={onResume} className="btn btn-xs btn-outline" title="Resume">
                Resume
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-sm btn-circle btn-error"
              title="Cancel"
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
        ) : (
          <button 
            type="submit" 
            className="btn btn-sm btn-circle btn-primary absolute"
            style={{ bottom: '10px', right: '10px' }}
            disabled={!prompt.trim() || tabStatus === 'detached'}
            title={tabStatus === 'detached' ? "Refresh tab to continue" : "Execute"}
          >
            <FontAwesomeIcon icon={faPaperPlane} />
          </button>
        )}
      </div>
    </form>
  );
};
