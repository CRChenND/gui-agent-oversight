import React from 'react';
import type {
  OversightMechanismDefinition,
  OversightMechanismId,
  OversightMechanismParameterSettings,
  OversightMechanismSettings,
  OversightParameterValue,
} from '../../../oversight/registry';
import { FeatureToggleSettings } from '../FeatureToggleSettings';
import { SaveButton } from '../SaveButton';

interface InteractionTabProps {
  mechanisms: OversightMechanismDefinition[];
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
  onToggle: (mechanismId: OversightMechanismId, enabled: boolean) => void;
  onParameterChange: (mechanismId: OversightMechanismId, parameterKey: string, value: OversightParameterValue) => void;
  isSaving: boolean;
  saveStatus: string;
  handleSave: () => void;
  handleExportDesignMatrix: () => void;
}

export function InteractionTab({
  mechanisms,
  settings,
  parameterSettings,
  onToggle,
  onParameterChange,
  isSaving,
  saveStatus,
  handleSave,
  handleExportDesignMatrix,
}: InteractionTabProps) {
  return (
    <div className="space-y-6">
      <div className="card bg-base-100 shadow-md">
        <div className="card-body">
          <h2 className="card-title text-xl">Interaction Features</h2>
          <p className="mb-4">Configure oversight, intervention, and monitoring features for agent interaction.</p>

          <FeatureToggleSettings
            mechanisms={mechanisms}
            settings={settings}
            parameterSettings={parameterSettings}
            onToggle={onToggle}
            onParameterChange={onParameterChange}
          />

          <div className="flex flex-wrap items-center gap-3">
            <SaveButton
              isSaving={isSaving}
              saveStatus={saveStatus}
              handleSave={handleSave}
              isDisabled={false}
            />
            <button
              className="btn btn-outline"
              onClick={handleExportDesignMatrix}
              type="button"
            >
              Export Design Matrix
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
