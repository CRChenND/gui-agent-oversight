import {
  OVERSIGHT_MECHANISM_REGISTRY,
  type OversightMechanismId,
} from '../registry';

export interface OversightDesignMatrixRow {
  id: OversightMechanismId;
  title: string;
  interruptionLevel: 'low' | 'medium' | 'high';
  oversightGranularity: 'step' | 'task';
  feedbackLatency: 'instant' | 'delayed';
  agencyModel: 'approval' | 'awareness' | 'prediction';
  parameterKeys: string[];
}

export function getOversightDesignMatrixRows(): OversightDesignMatrixRow[] {
  return OVERSIGHT_MECHANISM_REGISTRY.map((mechanism) => ({
    id: mechanism.id,
    title: mechanism.title,
    interruptionLevel: mechanism.interactionProperties.interruptionLevel,
    oversightGranularity: mechanism.interactionProperties.oversightGranularity,
    feedbackLatency: mechanism.interactionProperties.feedbackLatency,
    agencyModel: mechanism.interactionProperties.agencyModel,
    parameterKeys: (mechanism.parameters || []).map((parameter) => parameter.key),
  }));
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportDesignMatrix(format: 'json' | 'csv' = 'json'): string {
  const rows = getOversightDesignMatrixRows();

  if (format === 'json') {
    return JSON.stringify(rows, null, 2);
  }

  const header = [
    'id',
    'title',
    'interruptionLevel',
    'oversightGranularity',
    'feedbackLatency',
    'agencyModel',
    'parameterKeys',
  ];

  const lines = [header.join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.title,
        row.interruptionLevel,
        row.oversightGranularity,
        row.feedbackLatency,
        row.agencyModel,
        row.parameterKeys.join('|'),
      ]
        .map((cell) => escapeCsvCell(String(cell)))
        .join(',')
    );
  }

  return lines.join('\n');
}
