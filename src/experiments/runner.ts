import {
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  buildOversightParameterStoragePatch,
  buildOversightStoragePatch,
  createDefaultOversightParameterSettings,
  createDefaultOversightMechanismSettings,
  getOversightParameterStorageKey,
  type OversightMechanismId,
  type OversightMechanismParameterSettings,
  type OversightParameterValue,
} from '../oversight/registry';
import { EXPERIMENT_PRESENTATION_THEME } from '../oversight/presentationTheme';
import { getOversightSessionManager } from '../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import { DEFAULT_PROFILES } from './profiles/defaultProfiles';
import type { OversightProfile, OversightProfileId } from './profiles/types';
import {
  loadOversightExperimentConfigFromJson,
  parseOversightExperimentConfig,
  type ExperimentTaskSpec,
  type ParsedOversightExperimentConfig,
} from './schema';

const KNOWN_MECHANISMS: OversightMechanismId[] = [
  AGENT_FOCUS_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  ADAPTIVE_CONTROLLER_MECHANISM_ID,
];

const PROFILE_BY_ID = DEFAULT_PROFILES.reduce((acc, profile) => {
  acc[profile.id] = profile;
  return acc;
}, {} as Record<OversightProfileId, OversightProfile>);

export interface OversightExperimentTaskResult {
  task: string;
  taskId?: string;
  sessionId: string;
  profileId: OversightProfileId;
  telemetryEvents: OversightTelemetryEvent[];
}

export interface OversightExperimentRunResult {
  config: ParsedOversightExperimentConfig;
  results: OversightExperimentTaskResult[];
}

export interface OversightExperimentRunnerOptions {
  executeTask?: (task: ExperimentTaskSpec, sessionId: string, profileId: OversightProfileId) => Promise<void>;
  waitForTaskCompletion?: (task: ExperimentTaskSpec, sessionId: string) => Promise<void>;
}

function isKnownMechanismId(value: string): value is OversightMechanismId {
  return KNOWN_MECHANISMS.includes(value as OversightMechanismId);
}

function applyParameterOverride(
  parameterSettings: OversightMechanismParameterSettings,
  key: string,
  value: OversightParameterValue
): void {
  if (key.startsWith('oversight.')) {
    const parts = key.split('.');
    if (parts.length >= 3) {
      const mechanismId = parts[1];
      const parameterKey = parts.slice(2).join('.');
      if (isKnownMechanismId(mechanismId)) {
        parameterSettings[mechanismId][parameterKey] = value;
      }
    }
    return;
  }

  const separator = key.indexOf('.');
  if (separator <= 0) return;

  const mechanismId = key.slice(0, separator);
  const parameterKey = key.slice(separator + 1);
  if (!parameterKey) return;

  if (isKnownMechanismId(mechanismId)) {
    parameterSettings[mechanismId][parameterKey] = value;
  }

  if (key === 'gatePolicy') {
    parameterSettings[INTERVENTION_GATE_MECHANISM_ID].gatePolicy = value;
  }
}

function shuffleArray<T>(input: T[]): T[] {
  const next = [...input];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

async function defaultExecuteTask(task: ExperimentTaskSpec): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'executePrompt',
        prompt: task.prompt,
        taskContext: {
          taskId: task.id,
          steps: task.steps || [],
        },
      },
      () => {
        resolve();
      }
    );
  });
}

function resolveProfiles(config: ParsedOversightExperimentConfig): OversightProfile[] {
  if (config.profiles.length > 0) {
    return config.profiles.map((profileId) => PROFILE_BY_ID[profileId]).filter(Boolean);
  }

  if (config.mechanisms.length > 0) {
    return [
      {
        id: 'observe_only',
        title: 'Legacy Mechanism Config',
        enabledMechanisms: config.mechanisms,
      },
    ];
  }

  return [PROFILE_BY_ID.observe_only];
}

function buildTaskOrder(tasks: ExperimentTaskSpec[], shouldRandomize: boolean): ExperimentTaskSpec[] {
  return shouldRandomize ? shuffleArray(tasks) : [...tasks];
}

function buildProfileOrder(
  profiles: OversightProfile[],
  taskCount: number,
  randomizeConditions: boolean
): OversightProfile[] {
  const assignments: OversightProfile[] = [];
  if (randomizeConditions) {
    for (let i = 0; i < taskCount; i += 1) {
      assignments.push(profiles[Math.floor(Math.random() * profiles.length)]);
    }
    return assignments;
  }

  for (let i = 0; i < taskCount; i += 1) {
    assignments.push(profiles[i % profiles.length]);
  }
  return assignments;
}

export class OversightExperimentRunner {
  private readonly executeTask: (task: ExperimentTaskSpec, sessionId: string, profileId: OversightProfileId) => Promise<void>;
  private readonly waitForTaskCompletion?: (task: ExperimentTaskSpec, sessionId: string) => Promise<void>;

  constructor(options: OversightExperimentRunnerOptions = {}) {
    this.executeTask = options.executeTask ?? (async (task) => defaultExecuteTask(task));
    this.waitForTaskCompletion = options.waitForTaskCompletion;
  }

  loadConfig(input: string | unknown): ParsedOversightExperimentConfig {
    if (typeof input === 'string') {
      return loadOversightExperimentConfigFromJson(input);
    }
    return parseOversightExperimentConfig(input);
  }

  async applyMechanismSetup(
    profile: OversightProfile,
    globalOverrides: Record<string, OversightParameterValue>
  ): Promise<void> {
    const mechanismSettings = createDefaultOversightMechanismSettings();
    const parameterSettings = createDefaultOversightParameterSettings();

    for (const mechanismId of KNOWN_MECHANISMS) {
      mechanismSettings[mechanismId] = profile.enabledMechanisms.includes(mechanismId);
    }

    const mergedOverrides = {
      ...(profile.parameterOverrides || {}),
      ...globalOverrides,
    };

    for (const [key, value] of Object.entries(mergedOverrides)) {
      applyParameterOverride(parameterSettings, key, value);
    }

    const parameterPatch = buildOversightParameterStoragePatch(parameterSettings);
    for (const [rawKey, value] of Object.entries(mergedOverrides)) {
      if (rawKey.startsWith('oversight.')) {
        parameterPatch[rawKey] = value;
        continue;
      }

      if (rawKey === 'gatePolicy') {
        parameterPatch[getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'gatePolicy')] = value;
        continue;
      }

      const separator = rawKey.indexOf('.');
      if (separator > 0) {
        const mechanismId = rawKey.slice(0, separator);
        const parameterKey = rawKey.slice(separator + 1);
        if (isKnownMechanismId(mechanismId) && parameterKey) {
          parameterPatch[getOversightParameterStorageKey(mechanismId, parameterKey)] = value;
        }
      }
    }

    await chrome.storage.sync.set({
      ...buildOversightStoragePatch(mechanismSettings),
      ...parameterPatch,
      'oversight.presentationTheme.locked': EXPERIMENT_PRESENTATION_THEME.lockedInExperimentMode,
      'oversight.presentationTheme.riskColors': EXPERIMENT_PRESENTATION_THEME.riskColors,
      'oversight.presentationTheme.modalLayout': EXPERIMENT_PRESENTATION_THEME.modalLayout,
      'oversight.presentationTheme.panelDefaultExpansion': EXPERIMENT_PRESENTATION_THEME.panelDefaultExpansion,
    });
  }

  async run(input: string | unknown): Promise<OversightExperimentRunResult> {
    const config = this.loadConfig(input);
    const profiles = resolveProfiles(config);

    if (profiles.length === 0) {
      throw new Error('No valid profile is configured for the experiment run');
    }

    const taskOrder = buildTaskOrder(config.tasks, config.randomizeTaskOrder);
    const profileAssignments = buildProfileOrder(profiles, taskOrder.length, config.randomizeConditions);

    const sessionManager = getOversightSessionManager();
    const telemetryLogger = getOversightTelemetryLogger();
    const results: OversightExperimentTaskResult[] = [];

    for (let index = 0; index < taskOrder.length; index += 1) {
      const task = taskOrder[index];
      const profile = profileAssignments[index];
      await this.applyMechanismSetup(profile, config.parameterOverrides);

      const sessionId = await sessionManager.startSession();
      const orderedTaskIds = taskOrder.map((item) => item.id || item.prompt);

      telemetryLogger.log({
        sessionId,
        timestamp: Date.now(),
        source: 'system',
        eventType: 'state_transition',
        payload: {
          phase: 'session_metadata',
          participantId: config.participantId,
          profileId: profile.id,
          taskOrder: orderedTaskIds,
          taskId: task.id,
          taskPrompt: task.prompt,
          taskIndex: index,
        },
      });

      await this.executeTask(task, sessionId, profile.id);

      if (this.waitForTaskCompletion) {
        await this.waitForTaskCompletion(task, sessionId);
      }

      await telemetryLogger.flush();

      const telemetryEvents = telemetryLogger.getSessionEvents(sessionId);
      results.push({
        task: task.prompt,
        taskId: task.id,
        sessionId,
        profileId: profile.id,
        telemetryEvents,
      });

      await sessionManager.endSession();
    }

    return {
      config,
      results,
    };
  }
}
