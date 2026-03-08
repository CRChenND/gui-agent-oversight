import {
  createDefaultOversightMechanismSettings,
  createDefaultOversightParameterSettings,
  type OversightMechanismParameterSettings,
  type OversightMechanismSettings,
} from '../../oversight/registry';
import type { OversightArchetype } from './types';

export function createArchetypeBase(): {
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
} {
  return {
    settings: createDefaultOversightMechanismSettings(),
    parameterSettings: createDefaultOversightParameterSettings(),
  };
}

export function defineArchetype(
  archetype: OversightArchetype
): OversightArchetype {
  return archetype;
}
