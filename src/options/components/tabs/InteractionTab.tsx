import React, { useMemo, useState } from 'react';
import type {
  OversightMechanismDefinition,
  OversightMechanismId,
  OversightMechanismParameterSettings,
  OversightMechanismSettings,
  OversightParameterValue,
} from '../../../oversight/registry';
import type { OversightArchetype } from '../../archetypes';
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
  builtinArchetypes: OversightArchetype[];
  customArchetypes: OversightArchetype[];
  applyArchetype: (archetype: OversightArchetype) => void;
  saveCurrentAsArchetype: (name: string) => void;
  deleteCustomArchetype: (archetypeId: string) => void;
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
  builtinArchetypes,
  customArchetypes,
  applyArchetype,
  saveCurrentAsArchetype,
  deleteCustomArchetype,
}: InteractionTabProps) {
  const [selectedArchetypeId, setSelectedArchetypeId] = useState<string>('');
  const [newArchetypeName, setNewArchetypeName] = useState('');

  const allArchetypes = useMemo(
    () => [...builtinArchetypes, ...customArchetypes],
    [builtinArchetypes, customArchetypes]
  );
  const selectedArchetype = allArchetypes.find((item) => item.id === selectedArchetypeId);

  return (
    <div className="space-y-6">
      <div className="card bg-base-100 shadow-md">
        <div className="card-body">
          <h2 className="card-title text-xl">Archetype Presets</h2>
          <p className="text-sm text-base-content/80">
            Load one of the built-in oversight archetypes, or save current settings as a custom archetype.
          </p>

          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <select
              className="select select-bordered w-full"
              value={selectedArchetypeId}
              onChange={(e) => setSelectedArchetypeId(e.target.value)}
            >
              <option value="">Select archetype...</option>
              {builtinArchetypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} (Built-in)
                </option>
              ))}
              {customArchetypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} (Custom)
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedArchetype}
              onClick={() => {
                if (!selectedArchetype) return;
                applyArchetype(selectedArchetype);
              }}
            >
              Load Archetype
            </button>
          </div>

          {selectedArchetype ? (
            <div className="rounded border border-base-300 bg-base-200 p-3 text-sm">
              <div className="font-semibold">{selectedArchetype.name}</div>
              <div className="mt-1 text-base-content/80">{selectedArchetype.description}</div>
            </div>
          ) : null}

          <div className="divider my-1">Custom Archetype</div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <input
              className="input input-bordered w-full"
              placeholder="Name current settings..."
              value={newArchetypeName}
              onChange={(e) => setNewArchetypeName(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-outline"
              disabled={!newArchetypeName.trim()}
              onClick={() => {
                if (!newArchetypeName.trim()) return;
                saveCurrentAsArchetype(newArchetypeName.trim());
                setNewArchetypeName('');
              }}
            >
              Save As Archetype
            </button>
          </div>

          {customArchetypes.length > 0 ? (
            <div className="space-y-2">
              {customArchetypes.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 rounded border border-base-300 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="truncate text-xs text-base-content/70">{item.description}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-error"
                    onClick={() => deleteCustomArchetype(item.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-base-content/70">No custom archetypes yet.</div>
          )}
        </div>
      </div>

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
