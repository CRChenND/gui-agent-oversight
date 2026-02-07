import React from 'react';

interface GlobalKnowledgeSettingsProps {
  globalKnowledgeText: string;
  setGlobalKnowledgeText: (val: string) => void;
}

export function GlobalKnowledgeSettings({ globalKnowledgeText, setGlobalKnowledgeText }: GlobalKnowledgeSettingsProps) {
  return (
    <div className="border rounded-lg p-4 mb-4">
      <h3 className="font-bold mb-2">Agent Global Knowledge</h3>
      <p className="text-sm mb-2">
        These notes are always included in the agent's system prompt. Put one fact per line.
      </p>
      <textarea
        className="textarea textarea-bordered w-full h-32"
        placeholder={"e.g.\n- The default delivery address I often use is San Francisco."}
        value={globalKnowledgeText}
        onChange={(e) => setGlobalKnowledgeText(e.target.value)}
      />
    </div>
  );
}

