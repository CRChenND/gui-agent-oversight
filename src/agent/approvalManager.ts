import { waitForOverlayApprovalDecision } from '../background/attentionTracker';
import { buildApprovalDecisionCopy, handleApprovalRequested } from '../background/oversightManager';
import { getTabState, getWindowForTab } from '../background/tabManager';
import { sendUIMessage } from '../background/utils';
import {
  AGENT_FOCUS_MECHANISM_ID,
  getOversightStorageQueryDefaults,
  mapStorageToOversightSettings,
} from '../oversight/registry';
import { getDefaultOversightArchetype, OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY } from '../options/oversightArchetypes';

// Pending approvals map
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  toolName: string;
  toolInput: string;
  reason: string;
  approvalSeriesKey?: string | null;
  siteApprovalKey?: string | null;
}>();
const autoApprovedSeriesKeys = new Set<string>();
const autoApprovedSiteKeys = new Set<string>();

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

export async function requestPlanStepApproval(
  tabId: number,
  stepId: string,
  planStepNumber: number,
  planStepText: string,
  windowId?: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `plan_step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    pendingApprovals.set(requestId, {
      resolve,
      toolName: 'plan_step',
      toolInput: planStepText,
      reason: `Up next in the plan: Step ${planStepNumber}.`,
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
      reason: `The next part of the plan is Step ${planStepNumber}: ${planStepText}`,
      approvalVariant: 'supervisory-plan-step',
      planStepIndex: planStepNumber - 1,
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error sending plan-step approval request:', chrome.runtime.lastError);
        pendingApprovals.delete(requestId);
        resolve(false);
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
 * @returns A promise that resolves to true if approved, false if rejected
 */
export async function requestApproval(
  tabId: number,
  stepId: string,
  toolName: string,
  toolInput: string,
  reason: string,
  windowId?: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = generateUniqueId();
    const approvalSeriesKey = buildApprovalSeriesKey(toolName, toolInput);
    void resolveSiteApprovalKey(tabId).then((siteApprovalKey) => {
      if (siteApprovalKey && autoApprovedSiteKeys.has(siteApprovalKey)) {
        resolve(true);
        return;
      }
      if (approvalSeriesKey && autoApprovedSeriesKeys.has(approvalSeriesKey)) {
        resolve(true);
        return;
      }

      pendingApprovals.set(requestId, {
        resolve,
        toolName,
        toolInput,
        reason,
        approvalSeriesKey,
        siteApprovalKey,
      });

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
          });

          if (allowPageApprovalOverlay && enableAgentFocus && page) {
            void waitForOverlayApprovalDecision(page, requestId).then((decision) => {
              if (!decision || !pendingApprovals.has(requestId)) return;
              handleApprovalResponse(requestId, decision.approved, decision.approvalMode || 'once');
              sendUIMessage(
                'approvalResolved',
                {
                  requestId,
                  approved: decision.approved,
                },
                tabId,
                windowId
              );
            });
          }

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
              resolve(false);
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
          });
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
              resolve(false);
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
  approved: boolean,
  approvalMode: 'once' | 'series' | 'site' = 'once'
): void {
  const pendingApproval = pendingApprovals.get(requestId);
  if (pendingApproval) {
    if (approved && approvalMode === 'series' && pendingApproval.approvalSeriesKey) {
      autoApprovedSeriesKeys.add(pendingApproval.approvalSeriesKey);
    }
    if (approved && approvalMode === 'site' && pendingApproval.siteApprovalKey) {
      autoApprovedSiteKeys.add(pendingApproval.siteApprovalKey);
    }
    pendingApproval.resolve(approved);
    pendingApprovals.delete(requestId);
  } else {
    console.warn(`No pending approval found for requestId: ${requestId}`);
  }
}

/**
 * Generates a unique ID for approval requests
 * @returns A unique ID string
 */
function generateUniqueId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
