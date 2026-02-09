import React from 'react';
import type { ReplaySessionSummary, TraceStepSummary } from '../../replay/replayController';

interface ReplayTimelineProps {
  sessions: ReplaySessionSummary[];
  selectedSessionId: string;
  isTracePlaybackMode: boolean;
  eventCount: number;
  cursor: number;
  steps: TraceStepSummary[];
  selectedStepId: string | null;
  onSelectSession: (sessionId: string) => void;
  onLoadSession: () => void;
  onExitTracePlayback: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onJumpToPosition: (position: number) => void;
  onSelectStep: (stepId: string) => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function ReplayTimeline({
  sessions,
  selectedSessionId,
  isTracePlaybackMode,
  eventCount,
  cursor,
  steps,
  selectedStepId,
  onSelectSession,
  onLoadSession,
  onExitTracePlayback,
  onStepBackward,
  onStepForward,
  onJumpToPosition,
  onSelectStep,
}: ReplayTimelineProps) {
  const position = cursor + 1;

  return (
    <div className="card bg-base-100 shadow-md p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Trace Playback</span>
        <select
          className="select select-bordered select-sm"
          value={selectedSessionId}
          onChange={(e) => onSelectSession(e.target.value)}
        >
          <option value="">Select session</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.sessionId} ({new Date(session.startedAt).toLocaleTimeString()})
            </option>
          ))}
        </select>
        <button className="btn btn-sm btn-outline" onClick={onLoadSession} disabled={!selectedSessionId}>
          Load
        </button>
        <button className="btn btn-sm" onClick={onExitTracePlayback} disabled={!isTracePlaybackMode}>
          Exit
        </button>
      </div>

      {selectedSessionId && (
        <div className="mt-2 text-xs text-base-content/70">
          {sessions
            .filter((session) => session.sessionId === selectedSessionId)
            .map((session) => (
              <div key={session.sessionId}>
                {formatTime(session.startedAt)} - {formatTime(session.endedAt)} | {session.eventCount} telemetry events
              </div>
            ))}
        </div>
      )}

      {isTracePlaybackMode && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <button className="btn btn-xs" onClick={onStepBackward} disabled={position <= 0}>
              Prev
            </button>
            <button className="btn btn-xs" onClick={onStepForward} disabled={position >= eventCount}>
              Next
            </button>
            <span className="text-xs">{position} / {eventCount}</span>
          </div>
          <input
            className="range range-xs mt-2"
            type="range"
            min={0}
            max={Math.max(0, eventCount)}
            value={position}
            onChange={(e) => onJumpToPosition(Number(e.target.value))}
          />
          {steps.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {steps.map((step) => (
                <button
                  key={step.stepId}
                  className={`btn btn-xs ${selectedStepId === step.stepId ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => onSelectStep(step.stepId)}
                  title={`${step.toolName} @ ${formatTime(step.timestamp)}`}
                >
                  {step.toolName}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
