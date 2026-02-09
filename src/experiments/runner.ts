import {
  AGENT_FOCUS_MECHANISM_ID,
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
import { getOversightSessionManager } from '../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import {
  loadOversightExperimentConfigFromJson,
  parseOversightExperimentConfig,
  type ParsedOversightExperimentConfig,
} from './schema';

const KNOWN_MECHANISMS: OversightMechanismId[] = [AGENT_FOCUS_MECHANISM_ID, TASK_GRAPH_MECHANISM_ID];

export interface OversightExperimentTaskResult {
  task: string;
  sessionId: string;
  telemetryEvents: OversightTelemetryEvent[];
}

export interface OversightExperimentRunResult {
  config: ParsedOversightExperimentConfig;
  results: OversightExperimentTaskResult[];
}

export interface OversightExperimentRunnerOptions {
  executeTask?: (task: string) => Promise<void>;
  waitForTaskCompletion?: (task: string, sessionId: string) => Promise<void>;
}

function isKnownMechanismId(value: string): value is OversightMechanismId {
  return KNOWN_MECHANISMS.includes(value as OversightMechanismId);
}

function applyParameterOverride(
  parameterSettings: OversightMechanismParameterSettings,
  key: string,
  value: OversightParameterValue
): void {
  // Supported keys:
  // 1) mechanismId.paramKey (e.g. task-graph.maxNodes)
  // 2) oversight.<mechanismId>.<paramKey>
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
}

async function defaultExecuteTask(task: string): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ action: 'executePrompt', prompt: task }, () => {
      resolve();
    });
  });
}

export class OversightExperimentRunner {
  private readonly executeTask: (task: string) => Promise<void>;
  private readonly waitForTaskCompletion?: (task: string, sessionId: string) => Promise<void>;

  constructor(options: OversightExperimentRunnerOptions = {}) {
    this.executeTask = options.executeTask ?? defaultExecuteTask;
    this.waitForTaskCompletion = options.waitForTaskCompletion;
  }

  loadConfig(input: string | unknown): ParsedOversightExperimentConfig {
    if (typeof input === 'string') {
      return loadOversightExperimentConfigFromJson(input);
    }
    return parseOversightExperimentConfig(input);
  }

  async applyMechanismSetup(config: ParsedOversightExperimentConfig): Promise<void> {
    const mechanismSettings = createDefaultOversightMechanismSettings();
    const parameterSettings = createDefaultOversightParameterSettings();

    for (const mechanismId of KNOWN_MECHANISMS) {
      mechanismSettings[mechanismId] = config.mechanisms.includes(mechanismId);
    }

    for (const [key, value] of Object.entries(config.parameterOverrides)) {
      applyParameterOverride(parameterSettings, key, value);
    }

    const parameterPatch = buildOversightParameterStoragePatch(parameterSettings);

    // Make sure both supported parameter override key styles are mirrored into storage.
    for (const [rawKey, value] of Object.entries(config.parameterOverrides)) {
      if (rawKey.startsWith('oversight.')) {
        parameterPatch[rawKey] = value;
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
    });
  }

  async run(input: string | unknown): Promise<OversightExperimentRunResult> {
    const config = this.loadConfig(input);
    await this.applyMechanismSetup(config);

    const sessionManager = getOversightSessionManager();
    const telemetryLogger = getOversightTelemetryLogger();
    const results: OversightExperimentTaskResult[] = [];

    for (const task of config.tasks) {
      const sessionId = await sessionManager.startSession();

      telemetryLogger.log({
        sessionId,
        timestamp: Date.now(),
        source: 'system',
        eventType: 'state_transition',
        payload: {
          phase: 'experiment_task_started',
          task,
        },
      });

      await this.executeTask(task);

      if (this.waitForTaskCompletion) {
        await this.waitForTaskCompletion(task, sessionId);
      }

      await telemetryLogger.flush();

      const telemetryEvents = telemetryLogger.getSessionEvents(sessionId);
      results.push({
        task,
        sessionId,
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
