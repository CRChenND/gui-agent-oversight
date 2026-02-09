import React from 'react';
import type { ReplaySessionSummary } from '../../replay/replayController';

interface ReplayTimelineProps {
  sessions: ReplaySessionSummary[];
  selectedSessionId: string;
  isReplayMode: boolean;
  eventCount: number;
  cursor: number;
  onSelectSession: (sessionId: string) => void;
  onLoadSession: () => void;
  onExitReplay: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onJumpToPosition: (position: number) => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function ReplayTimeline({
  sessions,
  selectedSessionId,
  isReplayMode,
  eventCount,
  cursor,
  onSelectSession,
  onLoadSession,
  onExitReplay,
  onStepBackward,
  onStepForward,
  onJumpToPosition,
}: ReplayTimelineProps) {
  const position = cursor + 1;

  return (
    <div className="card bg-base-100 shadow-md p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Replay</span>
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
        <button className="btn btn-sm" onClick={onExitReplay} disabled={!isReplayMode}>
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

      {isReplayMode && (
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
        </div>
      )}
    </div>
  );
}
