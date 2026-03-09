import React from 'react';
import type { OversightArchetype } from '../../oversightArchetypes';

interface ArchetypesTabProps {
  archetypes: OversightArchetype[];
  selectedArchetypeId: string;
  onApplyArchetype: (archetype: OversightArchetype) => void;
  isSaving: boolean;
  saveStatus: string;
}

export function ArchetypesTab({
  archetypes,
  selectedArchetypeId,
  onApplyArchetype,
  isSaving,
  saveStatus,
}: ArchetypesTabProps) {
  return (
    <div className="space-y-6">
      <div className="card bg-base-100 shadow-md">
        <div className="card-body">
          <h2 className="card-title text-xl">Oversight Archetypes</h2>
          <p className="mb-4 text-base-content/80">
            Choose one of the four oversight regimes. Each archetype loads its own mechanism configuration.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            {archetypes.map((archetype) => {
              const isActive = archetype.id === selectedArchetypeId;

              return (
                <button
                  key={archetype.id}
                  type="button"
                  className={`rounded-xl border p-5 text-left transition ${
                    isActive
                      ? 'border-primary bg-primary/10 shadow-sm'
                      : 'border-base-300 bg-base-100 hover:border-primary/40'
                  }`}
                  onClick={() => onApplyArchetype(archetype)}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-lg font-semibold">{archetype.name}</div>
                    {isActive ? <span className="badge badge-primary">Selected</span> : null}
                  </div>
                  <p className="text-sm text-base-content/80">{archetype.description}</p>
                </button>
              );
            })}
          </div>

          {isSaving || saveStatus ? (
            <div className="text-sm text-base-content/70">
              {isSaving ? 'Activating archetype...' : saveStatus}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
