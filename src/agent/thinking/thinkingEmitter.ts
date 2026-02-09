import type { AgentThinkingSummary, OversightEvent } from '../../oversight/types';

type ThinkingDispatch = (event: OversightEvent) => void;

let thinkingDispatch: ThinkingDispatch | null = null;

export function registerThinkingDispatch(dispatch: ThinkingDispatch): void {
  thinkingDispatch = dispatch;
}

export function emitAgentThinking(
  stepId: string,
  toolName: string | undefined,
  thinking: AgentThinkingSummary
): void {
  const event: OversightEvent = {
    kind: 'agent_thinking',
    timestamp: Date.now(),
    stepId,
    toolName,
    thinking,
  };

  if (thinkingDispatch) {
    thinkingDispatch(event);
    return;
  }

  chrome.runtime.sendMessage({
    action: 'oversightEvent',
    content: { event },
  });
}

