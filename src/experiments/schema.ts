import type { OversightMechanismId, OversightParameterValue } from '../oversight/registry';

export type ExperimentParameterOverrides = Record<string, OversightParameterValue>;

export interface OversightExperimentConfig {
  mechanisms: string[];
  parameterOverrides: Record<string, any>;
  tasks: string[];
}

export interface ParsedOversightExperimentConfig {
  mechanisms: OversightMechanismId[];
  parameterOverrides: ExperimentParameterOverrides;
  tasks: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseOversightExperimentConfig(input: unknown): ParsedOversightExperimentConfig {
  if (!isObject(input)) {
    throw new Error('Invalid experiment config: expected object');
  }

  const rawMechanisms = input.mechanisms;
  const rawParameterOverrides = input.parameterOverrides;
  const rawTasks = input.tasks;

  if (!Array.isArray(rawMechanisms) || !rawMechanisms.every((item) => typeof item === 'string')) {
    throw new Error('Invalid experiment config: mechanisms must be a string[]');
  }

  if (!Array.isArray(rawTasks) || !rawTasks.every((item) => typeof item === 'string')) {
    throw new Error('Invalid experiment config: tasks must be a string[]');
  }

  if (!isObject(rawParameterOverrides)) {
    throw new Error('Invalid experiment config: parameterOverrides must be an object');
  }

  const parameterOverrides: ExperimentParameterOverrides = {};
  for (const [key, value] of Object.entries(rawParameterOverrides)) {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      parameterOverrides[key] = value;
      continue;
    }
    throw new Error(`Invalid parameter override for "${key}": only boolean/number/string are supported`);
  }

  return {
    mechanisms: rawMechanisms as OversightMechanismId[],
    parameterOverrides,
    tasks: rawTasks,
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
