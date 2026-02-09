import React from 'react';
import type { OversightMechanismDefinition, OversightMechanismId, OversightMechanismSettings } from '../../oversight/registry';

interface FeatureToggleSettingsProps {
  mechanisms: OversightMechanismDefinition[];
  settings: OversightMechanismSettings;
  onToggle: (mechanismId: OversightMechanismId, value: boolean) => void;
}

export function FeatureToggleSettings({
  mechanisms,
  settings,
  onToggle
}: FeatureToggleSettingsProps) {
  return (
    <div className="border rounded-lg p-4 mb-4">
      <h3 className="font-bold mb-2">Interaction Features</h3>
      <p className="text-sm mb-3">
        Control optional UI features in the side panel.
      </p>

      <div className="space-y-3">
        {mechanisms.map((mechanism) => (
          <label key={mechanism.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{mechanism.title}</div>
              <div className="text-xs text-base-content/70">{mechanism.description}</div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={settings[mechanism.id]}
              onChange={(e) => onToggle(mechanism.id, e.target.checked)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
