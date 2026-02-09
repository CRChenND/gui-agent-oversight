import React from 'react';
import type {
  OversightMechanismDefinition,
  OversightMechanismId,
  OversightMechanismParameterSettings,
  OversightParameterDescriptor,
  OversightParameterValue,
  OversightMechanismSettings
} from '../../oversight/registry';

interface FeatureToggleSettingsProps {
  mechanisms: OversightMechanismDefinition[];
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
  onToggle: (mechanismId: OversightMechanismId, value: boolean) => void;
  onParameterChange: (
    mechanismId: OversightMechanismId,
    parameterKey: string,
    value: OversightParameterValue
  ) => void;
}

function renderParameterControl(
  mechanismId: OversightMechanismId,
  descriptor: OversightParameterDescriptor,
  currentValue: OversightParameterValue,
  onParameterChange: FeatureToggleSettingsProps['onParameterChange']
) {
  if (descriptor.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className="toggle toggle-sm toggle-primary"
        checked={Boolean(currentValue)}
        onChange={(e) => onParameterChange(mechanismId, descriptor.key, e.target.checked)}
      />
    );
  }

  if (descriptor.type === 'number') {
    return (
      <input
        type="number"
        className="input input-bordered input-sm w-24"
        value={Number(currentValue)}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          onParameterChange(mechanismId, descriptor.key, Number.isFinite(parsed) ? parsed : descriptor.default);
        }}
      />
    );
  }

  return (
    <select
      className="select select-bordered select-sm"
      value={String(currentValue)}
      onChange={(e) => onParameterChange(mechanismId, descriptor.key, e.target.value)}
    >
      {(descriptor.options || []).map((option) => (
        <option key={String(option)} value={String(option)}>
          {String(option)}
        </option>
      ))}
    </select>
  );
}

export function FeatureToggleSettings({
  mechanisms,
  settings,
  parameterSettings,
  onToggle,
  onParameterChange
}: FeatureToggleSettingsProps) {
  return (
    <div className="border rounded-lg p-4 mb-4">
      <h3 className="font-bold mb-2">Interaction Features</h3>
      <p className="text-sm mb-3">
        Control optional UI features in the side panel.
      </p>

      <div className="space-y-3">
        {mechanisms.map((mechanism) => (
          <div key={mechanism.id} className="rounded border border-base-300 p-3">
            <label className="flex items-center justify-between gap-3">
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

            {mechanism.parameters && mechanism.parameters.length > 0 && (
              <div className="mt-3 space-y-2">
                {mechanism.parameters.map((parameter) => (
                  <div key={`${mechanism.id}:${parameter.key}`} className="flex items-center justify-between gap-2">
                    <div className="text-sm">
                      <span className="font-mono">{parameter.key}</span>
                    </div>
                    {renderParameterControl(
                      mechanism.id,
                      parameter,
                      parameterSettings[mechanism.id]?.[parameter.key] ?? parameter.default,
                      onParameterChange
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
