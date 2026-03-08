import type {
  OversightMechanismParameterSettings,
  OversightMechanismSettings,
} from '../../oversight/registry';

export interface OversightArchetype {
  id: string;
  name: string;
  description: string;
  authorityModel: string;
  visibilityStructure: string;
  oversightRhythm: string;
  settings: OversightMechanismSettings;
  parameterSettings: OversightMechanismParameterSettings;
}
