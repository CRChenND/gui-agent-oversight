export const AGENT_FOCUS_MECHANISM_ID = 'agent-focus' as const;
export const TASK_GRAPH_MECHANISM_ID = 'task-graph' as const;

export type OversightMechanismId =
  | typeof AGENT_FOCUS_MECHANISM_ID
  | typeof TASK_GRAPH_MECHANISM_ID;

export interface OversightMechanismDefinition {
  id: OversightMechanismId;
  title: string;
  description: string;
  storageKey: string;
  legacyStorageKeys?: string[];
  defaultEnabled: boolean;
}

export interface OversightMechanismSettings {
  [AGENT_FOCUS_MECHANISM_ID]: boolean;
  [TASK_GRAPH_MECHANISM_ID]: boolean;
}

export const OVERSIGHT_MECHANISM_REGISTRY: OversightMechanismDefinition[] = [
  {
    id: AGENT_FOCUS_MECHANISM_ID,
    title: 'Enable Agent Focus',
    description: 'Show page attention overlay for the current tool target.',
    storageKey: 'oversight.agentFocus.enabled',
    legacyStorageKeys: ['enableAgentFocus'],
    defaultEnabled: true,
  },
  {
    id: TASK_GRAPH_MECHANISM_ID,
    title: 'Enable Task Graph',
    description: 'Show step-by-step task nodes and status colors in the side panel.',
    storageKey: 'oversight.taskGraph.enabled',
    legacyStorageKeys: ['enableTaskGraph'],
    defaultEnabled: true,
  },
];

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

export function buildOversightStoragePatch(
  settings: OversightMechanismSettings
): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const mechanism of OVERSIGHT_MECHANISM_REGISTRY) {
    patch[mechanism.storageKey] = settings[mechanism.id];
  }
  return patch;
}
