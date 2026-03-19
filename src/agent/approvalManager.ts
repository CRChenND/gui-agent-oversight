import { waitForOverlayApprovalDecision } from '../background/attentionTracker';
import { buildApprovalDecisionCopy, buildPlanStepApprovalCopy, handleApprovalRequested } from '../background/oversightManager';
import { getTabState, getWindowForTab } from '../background/tabManager';
import { sendUIMessage } from '../background/utils';
import { getOversightRuntimeManager } from '../oversight/runtime/runtimeManager';
import {
  AGENT_FOCUS_MECHANISM_ID,
  getOversightStorageQueryDefaults,
  mapStorageToOversightSettings,
} from '../oversight/registry';
import { getDefaultOversightArchetype, OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY } from '../options/oversightArchetypes';

// Pending approvals map
export type ApprovalDecision = 'approve' | 'reject' | 'supersede';

const pendingApprovals = new Map<string, {
  resolve: (decision: ApprovalDecision) => void;
  toolName: string;
  toolInput: string;
  reason: string;
  createdAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  approvalSeriesKey?: string | null;
  siteApprovalKey?: string | null;
}>();
const autoApprovedSeriesKeys = new Set<string>();
const autoApprovedSiteKeys = new Set<string>();
const APPROVAL_REQUEST_TIMEOUT_MS = 45000;

function buildApprovalSeriesKey(toolName: string, toolInput: string): string | null {
  const normalizedTool = toolName.toLowerCase();
  const normalizedInput = toolInput.toLowerCase().replace(/\s+/g, ' ').trim();
  const quotedTarget = toolInput.match(/["']([^"']+)["']/)?.[1]?.trim().toLowerCase();
  const selectorTarget = toolInput.split(',')[0]?.trim().toLowerCase();
  const target = quotedTarget || selectorTarget || normalizedInput;

  if (normalizedTool.includes('type') || normalizedTool.includes('fill')) {
    return 'series:data-entry';
  }
  if (normalizedTool.includes('navigate')) {
    return 'series:navigation';
  }
  if (normalizedTool.includes('click')) {
    if (/(submit|delete|remove|pay|purchase|checkout|send|confirm|publish)/i.test(target)) {
      return `series:click:${target}`;
    }
    return 'series:ui-click';
  }

  return `series:${normalizedTool}`;
}

export function clearApprovalSeries(): void {
  autoApprovedSeriesKeys.clear();
  autoApprovedSiteKeys.clear();
}

export function hasPendingApproval(requestId: string): boolean {
  return pendingApprovals.has(requestId);
}

export async function requestPlanStepApproval(
  tabId: number,
  stepId: string,
  planStepNumber: number,
  planStepText: string,
  windowId?: number
): Promise<'accept' | 'reject' | 'revise'> {
  return new Promise((resolve) => {
    const requestId = `plan_step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    pendingApprovals.set(requestId, {
      resolve: (decision) => resolve(decision === 'approve' ? 'accept' : decision === 'supersede' ? 'revise' : 'reject'),
      toolName: 'plan_step',
      toolInput: planStepText,
      reason: `Up next in the plan: Step ${planStepNumber}.`,
      createdAt: Date.now(),
    });

    if (!windowId) {
      try {
        windowId = getWindowForTab(tabId);
      } catch (error) {
        console.error('Error getting window ID for plan-step approval:', error);
      }
    }

    chrome.runtime.sendMessage({
      action: 'requestApproval',
      tabId,
      windowId,
      requestId,
      stepId,
      toolName: 'plan_step',
      toolInput: planStepText,
      reason: buildPlanStepApprovalCopy(planStepNumber, planStepText),
      approvalVariant: 'supervisory-plan-step',
      planStepIndex: planStepNumber - 1,
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error sending plan-step approval request:', chrome.runtime.lastError);
        void getOversightRuntimeManager()
          .pauseForRejectedAction(windowId, 'plan_step_rejected')
          .catch((error) => {
            console.warn('[approval-debug] Failed to pause runtime after plan-step approval delivery error', error);
          })
          .finally(() => {
            pendingApprovals.delete(requestId);
            resolve('reject');
          });
      }
    });
  });
}

async function resolveSiteApprovalKey(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return null;
    const origin = new URL(tab.url).origin;
    return origin && origin !== 'null' ? `site:${origin}` : null;
  } catch (error) {
    console.warn('Failed to resolve site approval key:', error);
    return null;
  }
}

/**
 * Requests approval from the user for a tool execution
 * @param tabId The tab ID to request approval for
 * @param toolName The name of the tool being executed
 * @param toolInput The input to the tool
 * @param reason The reason approval is required
 * @param windowId Optional window ID to scope the approval request to a specific window
 * @returns A promise that resolves to approve, reject, or supersede
 */
export async function requestApproval(
  tabId: number,
  stepId: string,
  toolName: string,
  toolInput: string,
  reason: string,
  windowId?: number,
  options?: {
    stepDescription?: string;
  }
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const requestId = generateUniqueId();
    const approvalSeriesKey = buildApprovalSeriesKey(toolName, toolInput);
    void resolveSiteApprovalKey(tabId).then((siteApprovalKey) => {
      if (siteApprovalKey && autoApprovedSiteKeys.has(siteApprovalKey)) {
        resolve('approve');
        return;
      }
      if (approvalSeriesKey && autoApprovedSeriesKeys.has(approvalSeriesKey)) {
        resolve('approve');
        return;
      }

      pendingApprovals.set(requestId, {
        resolve,
        toolName,
        toolInput,
        reason,
        createdAt: Date.now(),
        approvalSeriesKey,
        siteApprovalKey,
      });
      console.info('[approval-debug] Approval requested', {
        requestId,
        stepId,
        toolName,
        toolInput,
        reason,
        windowId,
      });
      const timeoutId = setTimeout(() => {
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        console.warn('[approval-debug] Approval timed out; auto-rejecting request', {
          requestId,
          stepId,
          toolName,
          toolInput,
          waitedMs: Date.now() - pending.createdAt,
        });
        void getOversightRuntimeManager()
          .pauseForRejectedAction(windowId, 'approval_rejected')
          .catch((error) => {
            console.warn('[approval-debug] Failed to pause runtime after approval timeout', error);
          })
          .finally(() => {
            handleApprovalResponse(requestId, 'reject', 'once');
            sendUIMessage(
              'approvalResolved',
              {
                requestId,
                approved: false,
              },
              tabId,
              windowId
            );
          });
      }, APPROVAL_REQUEST_TIMEOUT_MS);
      const currentPending = pendingApprovals.get(requestId);
      if (currentPending) {
        currentPending.timeoutId = timeoutId;
      }

      if (!windowId) {
        try {
          windowId = getWindowForTab(tabId);
        } catch (error) {
          console.error('Error getting window ID for tab:', error);
        }
      }

      void chrome.storage.sync
        .get({
          ...getOversightStorageQueryDefaults(),
          [OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]: getDefaultOversightArchetype().id,
        })
        .then((result) => {
          const oversightSettings = mapStorageToOversightSettings(result as Record<string, unknown>);
          const enableAgentFocus = Boolean(oversightSettings[AGENT_FOCUS_MECHANISM_ID]);
          const selectedArchetypeId =
            typeof result[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY] === 'string'
              ? result[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]
              : getDefaultOversightArchetype().id;
          const allowPageApprovalOverlay = selectedArchetypeId === 'structural-amplification';
          const page = getTabState(tabId)?.page;
          const actionTitle = toolName.includes('click')
            ? `Interact with "${toolInput.match(/["']([^"']+)["']/)?.[1]?.trim() || 'this item'}"`
            : toolName.includes('type') || toolName.includes('fill')
              ? 'Enter information'
              : toolName.includes('navigate')
                ? 'Open the next page'
                : 'Continue with the next action';
          const displayReason = buildApprovalDecisionCopy({
            actionTitle,
            toolName,
            toolInput,
            thinking: reason,
            stepDescription: options?.stepDescription,
          });

          if (allowPageApprovalOverlay && enableAgentFocus && page) {
            void waitForOverlayApprovalDecision(page, requestId).then((decision) => {
              if (!decision || !pendingApprovals.has(requestId)) return;
              console.info('[approval-debug] Overlay resolving approval inside background', {
                requestId,
                approved: decision.approved,
                approvalMode: decision.approvalMode || 'once',
                tabId,
                windowId,
              });

              const finalizeOverlayDecision = () => {
                handleApprovalResponse(requestId, decision.approved ? 'approve' : 'reject', decision.approvalMode || 'once');
                sendUIMessage(
                  'approvalResolved',
                  {
                    requestId,
                    approved: decision.approved,
                  },
                  tabId,
                  windowId
                );
              };

              if (!decision.approved) {
                void getOversightRuntimeManager()
                  .pauseForRejectedAction(windowId, 'approval_rejected')
                  .then(finalizeOverlayDecision)
                  .catch((error) => {
                    console.warn('[approval-debug] Failed to pause runtime for overlay rejection', error);
                    finalizeOverlayDecision();
                  });
                return;
              }

              finalizeOverlayDecision();
            });
          }

          if (pendingApprovals.has(requestId)) {
            void handleApprovalRequested({
              stepId,
              requestId,
              tabId,
              windowId,
              page,
              toolName,
              toolInput,
              reason,
              enableAgentFocus: allowPageApprovalOverlay && enableAgentFocus,
            });
          }

          chrome.runtime.sendMessage({
            action: 'requestApproval',
            tabId,
            windowId,
            requestId,
            stepId,
            toolName,
            toolInput,
            reason: displayReason,
            approvalVariant:
              selectedArchetypeId === 'action-confirmation'
                ? 'action-confirmation'
                : selectedArchetypeId === 'supervisory-co-execution'
                  ? 'supervisory'
                  : 'default',
          }, (_response) => {
            if (chrome.runtime.lastError) {
              console.error('Error sending approval request:', chrome.runtime.lastError);
            }
          });
        })
        .catch((error) => {
          console.warn('Failed to load oversight settings for approval overlay:', error);
          const fallbackReason = buildApprovalDecisionCopy({
            actionTitle:
              toolName.includes('click')
                ? `Interact with "${toolInput.match(/["']([^"']+)["']/)?.[1]?.trim() || 'this item'}"`
                : toolName.includes('type') || toolName.includes('fill')
                  ? 'Enter information'
                  : toolName.includes('navigate')
                    ? 'Open the next page'
                    : 'Continue with the next action',
            toolName,
            toolInput,
            thinking: reason,
            stepDescription: options?.stepDescription,
          });
          if (pendingApprovals.has(requestId)) {
            void handleApprovalRequested({
              stepId,
              requestId,
              tabId,
              windowId,
              page: getTabState(tabId)?.page,
              toolName,
              toolInput,
              reason,
              enableAgentFocus: false,
            });
          }
          chrome.runtime.sendMessage({
            action: 'requestApproval',
            tabId,
            windowId,
            requestId,
            stepId,
            toolName,
            toolInput,
            reason: fallbackReason,
            approvalVariant: 'default',
          }, (_response) => {
            if (chrome.runtime.lastError) {
              console.error('Error sending approval request:', chrome.runtime.lastError);
            }
          });
        });
    });
  });
}

/**
 * Handles an approval response from the UI
 * @param requestId The ID of the approval request
 * @param approved Whether the request was approved
 */
export function handleApprovalResponse(
  requestId: string,
  decision: ApprovalDecision,
  approvalMode: 'once' | 'series' | 'site' = 'once'
): boolean {
  const pendingApproval = pendingApprovals.get(requestId);
  if (pendingApproval) {
    if (pendingApproval.timeoutId) {
      clearTimeout(pendingApproval.timeoutId);
    }
    if (decision === 'approve' && approvalMode === 'series' && pendingApproval.approvalSeriesKey) {
      autoApprovedSeriesKeys.add(pendingApproval.approvalSeriesKey);
    }
    if (decision === 'approve' && approvalMode === 'site' && pendingApproval.siteApprovalKey) {
      autoApprovedSiteKeys.add(pendingApproval.siteApprovalKey);
    }
    console.info('[approval-debug] Approval resolved', {
      requestId,
      decision,
      approvalMode,
      toolName: pendingApproval.toolName,
      toolInput: pendingApproval.toolInput,
      waitedMs: Date.now() - pendingApproval.createdAt,
    });
    pendingApproval.resolve(decision);
    pendingApprovals.delete(requestId);
    return true;
  } else {
    console.warn(`No pending approval found for requestId: ${requestId}`);
    return false;
  }
}

/**
 * Generates a unique ID for approval requests
 * @returns A unique ID string
 */
function generateUniqueId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
