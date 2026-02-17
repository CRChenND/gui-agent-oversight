import type { OversightParameterValue } from '../oversight/registry';
import type { StepImpact } from '../oversight/types';
import type { OversightProfileId } from './profiles/types';

export type ExperimentParameterOverrides = Record<string, OversightParameterValue>;

export interface TaskStepGroundTruth {
  stepId: string;
  impact: StepImpact;
  reversible?: boolean;
  gold_risky: boolean;
  category?: string;
}

export interface ExperimentTaskSpec {
  id?: string;
  prompt: string;
  steps?: TaskStepGroundTruth[];
}

export interface OversightExperimentConfig {
  mechanisms?: string[];
  parameterOverrides?: Record<string, any>;
  profiles?: OversightProfileId[];
  tasks: Array<string | ExperimentTaskSpec>;
  randomizeConditions?: boolean;
  randomizeTaskOrder?: boolean;
  participantId?: string;
}

export interface ParsedOversightExperimentConfig {
  mechanisms: string[];
  parameterOverrides: ExperimentParameterOverrides;
  profiles: OversightProfileId[];
  tasks: ExperimentTaskSpec[];
  randomizeConditions: boolean;
  randomizeTaskOrder: boolean;
  participantId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStepGroundTruth(value: unknown, index: number): TaskStepGroundTruth {
  if (!isObject(value)) {
    throw new Error(`Invalid task step at index ${index}: expected object`);
  }

  const stepId = value.stepId;
  const impact = value.impact;
  const goldRisky = value.gold_risky;

  if (typeof stepId !== 'string' || !stepId.trim()) {
    throw new Error(`Invalid task step at index ${index}: stepId must be a non-empty string`);
  }

  if (impact !== 'low' && impact !== 'medium' && impact !== 'high') {
    throw new Error(`Invalid task step at index ${index}: impact must be low|medium|high`);
  }

  if (typeof goldRisky !== 'boolean') {
    throw new Error(`Invalid task step at index ${index}: gold_risky must be boolean`);
  }

  const reversible = value.reversible;
  const category = value.category;

  return {
    stepId,
    impact,
    reversible: typeof reversible === 'boolean' ? reversible : undefined,
    gold_risky: goldRisky,
    category: typeof category === 'string' ? category : undefined,
  };
}

function parseTaskSpec(value: unknown, index: number): ExperimentTaskSpec {
  if (typeof value === 'string') {
    return {
      id: `task_${index + 1}`,
      prompt: value,
      steps: [],
    };
  }

  if (!isObject(value)) {
    throw new Error(`Invalid task at index ${index}: expected string or object`);
  }

  const prompt = value.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error(`Invalid task at index ${index}: prompt must be a non-empty string`);
  }

  const id = typeof value.id === 'string' && value.id.trim() ? value.id : `task_${index + 1}`;

  const rawSteps = value.steps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((step, stepIndex) => parseStepGroundTruth(step, stepIndex))
    : [];

  return {
    id,
    prompt,
    steps,
  };
}

function parseParticipantId(rawParticipantId: unknown): string {
  if (typeof rawParticipantId === 'string' && rawParticipantId.trim()) {
    return rawParticipantId;
  }
  return `participant_${Date.now()}`;
}

export function parseOversightExperimentConfig(input: unknown): ParsedOversightExperimentConfig {
  if (!isObject(input)) {
    throw new Error('Invalid experiment config: expected object');
  }

  const rawMechanisms = input.mechanisms;
  const rawParameterOverrides = input.parameterOverrides;
  const rawTasks = input.tasks;
  const rawProfiles = input.profiles;

  if (!Array.isArray(rawTasks)) {
    throw new Error('Invalid experiment config: tasks must be an array');
  }

  const tasks = rawTasks.map((task, index) => parseTaskSpec(task, index));

  if (rawMechanisms !== undefined && (!Array.isArray(rawMechanisms) || !rawMechanisms.every((item) => typeof item === 'string'))) {
    throw new Error('Invalid experiment config: mechanisms must be a string[] when provided');
  }

  if (
    rawProfiles !== undefined &&
    (!Array.isArray(rawProfiles) || !rawProfiles.every((item) => item === 'observe_only' || item === 'stepwise' || item === 'impact_gated' || item === 'adaptive'))
  ) {
    throw new Error('Invalid experiment config: profiles must be OversightProfileId[] when provided');
  }

  if (rawParameterOverrides !== undefined && !isObject(rawParameterOverrides)) {
    throw new Error('Invalid experiment config: parameterOverrides must be an object');
  }

  const parameterOverrides: ExperimentParameterOverrides = {};
  for (const [key, value] of Object.entries((rawParameterOverrides || {}) as Record<string, unknown>)) {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      parameterOverrides[key] = value;
      continue;
    }
    throw new Error(`Invalid parameter override for "${key}": only boolean/number/string are supported`);
  }

  return {
    mechanisms: (rawMechanisms || []) as string[],
    parameterOverrides,
    profiles: (rawProfiles || []) as OversightProfileId[],
    tasks,
    randomizeConditions: Boolean(input.randomizeConditions),
    randomizeTaskOrder: Boolean(input.randomizeTaskOrder),
    participantId: parseParticipantId(input.participantId),
  };
}

export function loadOversightExperimentConfigFromJson(jsonText: string): ParsedOversightExperimentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Invalid experiment config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseOversightExperimentConfig(parsed);
}
