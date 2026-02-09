export const AGENT_FOCUS_MECHANISM_ID = 'agent-focus' as const;
export const TASK_GRAPH_MECHANISM_ID = 'task-graph' as const;

export type OversightMechanismId =
  | typeof AGENT_FOCUS_MECHANISM_ID
  | typeof TASK_GRAPH_MECHANISM_ID;

export type OversightParameterType = 'number' | 'boolean' | 'enum';
export type OversightParameterValue = number | boolean | string;

export interface OversightParameterDescriptor {
  key: string;
  type: OversightParameterType;
  default: OversightParameterValue;
  options?: OversightParameterValue[];
}

export interface OversightInteractionProperties {
  interruptionLevel: 'low' | 'medium' | 'high';
  oversightGranularity: 'step' | 'task';
  feedbackLatency: 'instant' | 'delayed';
  agencyModel: 'approval' | 'awareness' | 'prediction';
}

export interface OversightMechanismDescriptor {
  id: OversightMechanismId;
  title: string;
  description: string;
  storageKey: string;
  legacyStorageKeys?: string[];
  defaultEnabled: boolean;
  interactionProperties: OversightInteractionProperties;
  parameters?: OversightParameterDescriptor[];
}

export type OversightMechanismDefinition = OversightMechanismDescriptor;

export interface OversightMechanismSettings {
  [AGENT_FOCUS_MECHANISM_ID]: boolean;
  [TASK_GRAPH_MECHANISM_ID]: boolean;
}

export type OversightMechanismParameterSettings = Record<
  OversightMechanismId,
  Record<string, OversightParameterValue>
>;

export const OVERSIGHT_MECHANISM_REGISTRY: OversightMechanismDescriptor[] = [
  {
    id: AGENT_FOCUS_MECHANISM_ID,
    title: 'Enable Agent Focus',
    description: 'Show page attention overlay for the current tool target.',
    storageKey: 'oversight.agentFocus.enabled',
    legacyStorageKeys: ['enableAgentFocus'],
    defaultEnabled: true,
    interactionProperties: {
      interruptionLevel: 'low',
      oversightGranularity: 'step',
      feedbackLatency: 'instant',
      agencyModel: 'awareness',
    },
    parameters: [
      {
        key: 'showToolName',
        type: 'boolean',
        default: true,
      },
    ],
  },
  {
    id: TASK_GRAPH_MECHANISM_ID,
    title: 'Enable Task Graph',
    description: 'Show step-by-step task nodes and status colors in the side panel.',
    storageKey: 'oversight.taskGraph.enabled',
    legacyStorageKeys: ['enableTaskGraph'],
    defaultEnabled: true,
    interactionProperties: {
      interruptionLevel: 'low',
      oversightGranularity: 'task',
      feedbackLatency: 'instant',
      agencyModel: 'prediction',
    },
    parameters: [
      {
        key: 'autoExpand',
        type: 'boolean',
        default: true,
      },
      {
        key: 'maxNodes',
        type: 'number',
        default: 20,
      },
    ],
  },
];

const MECHANISM_DESCRIPTOR_BY_ID = OVERSIGHT_MECHANISM_REGISTRY.reduce((acc, mechanism) => {
  acc[mechanism.id] = mechanism;
  return acc;
}, {} as Record<OversightMechanismId, OversightMechanismDescriptor>);

export function createDefaultOversightMechanismSettings(): OversightMechanismSettings {
  return OVERSIGHT_MECHANISM_REGISTRY.reduce((acc, mechanism) => {
    acc[mechanism.id] = mechanism.defaultEnabled;
    return acc;
  }, {} as OversightMechanismSettings);
}

export function getOversightStorageQueryDefaults(): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};

  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    defaults[mechanism.storageKey] = mechanism.defaultEnabled;
    for (const legacyKey of mechanism.legacyStorageKeys || []) {
      defaults[legacyKey] = mechanism.defaultEnabled;
    }
  }

  return defaults;
}

export function getOversightParameterStorageKey(mechanismId: OversightMechanismId, parameterKey: string): string {
  return `oversight.${mechanismId}.${parameterKey}`;
}

export function createDefaultOversightParameterSettings(): OversightMechanismParameterSettings {
  const defaults = {} as OversightMechanismParameterSettings;

  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    defaults[mechanism.id] = {};
    for (const parameter of mechanism.parameters || []) {
      defaults[mechanism.id][parameter.key] = parameter.default;
    }
  }

  return defaults;
}

export function getOversightParameterStorageQueryDefaults(): Record<string, OversightParameterValue> {
  const defaults: Record<string, OversightParameterValue> = {};
  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    for (const parameter of mechanism.parameters || []) {
      defaults[getOversightParameterStorageKey(mechanism.id, parameter.key)] = parameter.default;
    }
  }
  return defaults;
}

export function mapStorageToOversightSettings(storage: Record<string, unknown>): OversightMechanismSettings {
  const settings = createDefaultOversightMechanismSettings();

  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    const primaryValue = storage[mechanism.storageKey];
    if (typeof primaryValue === 'boolean') {
      settings[mechanism.id] = primaryValue;
      continue;
    }

    let legacyValue: boolean | null = null;
    for (const legacyKey of mechanism.legacyStorageKeys || []) {
      const candidate = storage[legacyKey];
      if (typeof candidate === 'boolean') {
        legacyValue = candidate;
        break;
      }
    }

    if (legacyValue !== null) {
      settings[mechanism.id] = legacyValue;
    }
  }

  return settings;
}

function coerceParameterValue(
  descriptor: OversightParameterDescriptor,
  rawValue: unknown
): OversightParameterValue {
  if (descriptor.type === 'boolean') {
    return typeof rawValue === 'boolean' ? rawValue : descriptor.default;
  }

  if (descriptor.type === 'number') {
    return typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : descriptor.default;
  }

  if (descriptor.type === 'enum') {
    if (typeof rawValue === 'string' && descriptor.options?.includes(rawValue)) {
      return rawValue;
    }
    return descriptor.default;
  }

  return descriptor.default;
}

export function mapStorageToOversightParameterSettings(
  storage: Record<string, unknown>
): OversightMechanismParameterSettings {
  const settings = createDefaultOversightParameterSettings();

  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    for (const parameter of mechanism.parameters || []) {
      const key = getOversightParameterStorageKey(mechanism.id, parameter.key);
      settings[mechanism.id][parameter.key] = coerceParameterValue(parameter, storage[key]);
    }
  }

  return settings;
}

export function buildOversightStoragePatch(
  settings: OversightMechanismSettings
): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    patch[mechanism.storageKey] = settings[mechanism.id];
  }
  return patch;
}

export function buildOversightParameterStoragePatch(
  settings: OversightMechanismParameterSettings
): Record<string, OversightParameterValue> {
  const patch: Record<string, OversightParameterValue> = {};
  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    for (const parameter of mechanism.parameters || []) {
      const key = getOversightParameterStorageKey(mechanism.id, parameter.key);
      const value = settings[mechanism.id]?.[parameter.key];
      patch[key] = value === undefined ? parameter.default : value;
    }
  }
  return patch;
}

export function getOversightParameterDefaultValue(
  mechanismId: OversightMechanismId,
  parameterKey: string
): OversightParameterValue | undefined {
  const descriptor = MECHANISM_DESCRIPTOR_BY_ID[mechanismId]?.parameters?.find((item) => item.key === parameterKey);
  return descriptor?.default;
}
