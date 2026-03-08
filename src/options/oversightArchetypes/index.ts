import type { OversightArchetype } from './types';
import type {
  OversightMechanismParameterSettings,
  OversightMechanismSettings,
} from '../../oversight/registry';
import { actionConfirmationArchetype } from './actionConfirmation';
import { riskGatedArchetype } from './riskGated';
import { structuralAmplificationArchetype } from './structuralAmplification';
import { supervisoryCoExecutionArchetype } from './supervisoryCoExecution';

export const OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY = 'oversight.selectedArchetypeId';

export const BUILTIN_OVERSIGHT_ARCHETYPES: OversightArchetype[] = [
  riskGatedArchetype,
  supervisoryCoExecutionArchetype,
  actionConfirmationArchetype,
  structuralAmplificationArchetype,
];

export function getDefaultOversightArchetype(): OversightArchetype {
  return BUILTIN_OVERSIGHT_ARCHETYPES[0];
}

export function getOversightArchetypeById(
  archetypeId: string
): OversightArchetype | undefined {
  return BUILTIN_OVERSIGHT_ARCHETYPES.find((archetype) => archetype.id === archetypeId);
}

export function inferOversightArchetypeId(
  settings: OversightMechanismSettings,
  parameterSettings: OversightMechanismParameterSettings
): string | undefined {
  return BUILTIN_OVERSIGHT_ARCHETYPES.find((archetype) => {
    const settingsMatch = Object.entries(archetype.settings).every(
      ([mechanismId, enabled]) => settings[mechanismId as keyof OversightMechanismSettings] === enabled
    );

    if (!settingsMatch) {
      return false;
    }

    return Object.entries(archetype.parameterSettings).every(([mechanismId, parameters]) =>
      Object.entries(parameters).every(
        ([parameterKey, value]) =>
          parameterSettings[mechanismId as keyof OversightMechanismParameterSettings]?.[parameterKey] === value
      )
    );
  })?.id;
}

export function cloneArchetypeState(archetype: OversightArchetype): Pick<
  OversightArchetype,
  'settings' | 'parameterSettings'
> {
  return {
    settings: { ...archetype.settings },
    parameterSettings: Object.fromEntries(
      Object.entries(archetype.parameterSettings).map(([mechanismId, parameters]) => [
        mechanismId,
        { ...parameters },
      ])
    ) as OversightArchetype['parameterSettings'],
  };
}

export type { OversightArchetype } from './types';
