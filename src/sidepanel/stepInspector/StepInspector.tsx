import React from 'react';
import type { StepInspectionData } from '../../replay/replayController';

interface StepInspectorProps {
  data: StepInspectionData | null;
}

function renderList(items: string[]): React.ReactNode {
  if (items.length === 0) return <span className="text-base-content/60">None</span>;
  return (
    <ul className="list-disc pl-5">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

export function StepInspector({ data }: StepInspectorProps) {
  if (!data) {
    return (
      <div className="card bg-base-100 shadow-md p-3 text-sm text-base-content/70">
        Select a trace step to inspect detailed agent, oversight, and human interaction context.
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow-md p-3 space-y-3 text-sm">
      <div>
        <div className="font-semibold">Step Inspector</div>
        <div className="text-xs text-base-content/70">
          {data.stepId} • {new Date(data.timestamp).toLocaleString()}
        </div>
      </div>

      <div>
        <div className="font-medium">Agent Data</div>
        <div><span className="font-semibold">Goal:</span> {data.goal || 'N/A'}</div>
        <div><span className="font-semibold">Plan:</span> {renderList(data.plan)}</div>
        <div><span className="font-semibold">Memory Read:</span> {renderList(data.memoryRead)}</div>
        <div><span className="font-semibold">Memory Write:</span> {renderList(data.memoryWrite)}</div>
        <div><span className="font-semibold">Rationale:</span> {data.rationale || 'N/A'}</div>
        <div><span className="font-semibold">Uncertainty:</span> {data.uncertainty}</div>
        <div><span className="font-semibold">Risk Flags:</span> {renderList(data.riskFlags)}</div>
      </div>

      <div>
        <div className="font-medium">Oversight Context</div>
        <div><span className="font-semibold">Triggered mechanisms:</span> {renderList(data.triggeredMechanisms)}</div>
        <div className="overflow-x-auto">
          <div className="font-semibold">Parameters at runtime:</div>
          <pre className="text-xs bg-base-200 p-2 rounded">{JSON.stringify(data.parametersAtRuntime, null, 2)}</pre>
        </div>
      </div>

      <div>
        <div className="font-medium">Human Interaction</div>
        <div><span className="font-semibold">Intervention actions:</span> {renderList(data.interventionActions)}</div>
        <div><span className="font-semibold">Approval decisions:</span> {renderList(data.approvalDecisions)}</div>
        <div>
          <span className="font-semibold">Monitoring dwell time:</span>{' '}
          {typeof data.monitoringDwellTimeMs === 'number' ? `${data.monitoringDwellTimeMs} ms` : 'N/A'}
        </div>
      </div>
    </div>
  );
}

