import React from 'react';

interface FeatureToggleSettingsProps {
  enableAgentFocus: boolean;
  setEnableAgentFocus: (value: boolean) => void;
  enableTaskGraph: boolean;
  setEnableTaskGraph: (value: boolean) => void;
}

export function FeatureToggleSettings({
  enableAgentFocus,
  setEnableAgentFocus,
  enableTaskGraph,
  setEnableTaskGraph
}: FeatureToggleSettingsProps) {
  return (
    <div className="border rounded-lg p-4 mb-4">
      <h3 className="font-bold mb-2">Interaction Features</h3>
      <p className="text-sm mb-3">
        Control optional UI features in the side panel.
      </p>

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">Enable Agent Focus</div>
            <div className="text-xs text-base-content/70">
              Show page attention overlay for the current tool target.
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={enableAgentFocus}
            onChange={(e) => setEnableAgentFocus(e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">Enable Task Graph</div>
            <div className="text-xs text-base-content/70">
              Show step-by-step task nodes and status colors in the side panel.
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={enableTaskGraph}
            onChange={(e) => setEnableTaskGraph(e.target.checked)}
          />
        </label>
      </div>
    </div>
  );
}
