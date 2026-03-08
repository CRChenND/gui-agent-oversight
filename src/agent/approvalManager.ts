import { waitForOverlayApprovalDecision } from '../background/attentionTracker';
import { handleApprovalRequested } from '../background/oversightManager';
import { getTabState, getWindowForTab } from '../background/tabManager';
import { sendUIMessage } from '../background/utils';
import {
  AGENT_FOCUS_MECHANISM_ID,
  getOversightStorageQueryDefaults,
  mapStorageToOversightSettings,
} from '../oversight/registry';

// Pending approvals map
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void,
  toolName: string,
  toolInput: string,
  reason: string
}>();

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
    pendingApprovals.set(requestId, { resolve, toolName, toolInput, reason });
    
    // Get the window ID if not provided
    if (!windowId) {
      try {
        // Try to get the window ID from the tab manager
        windowId = getWindowForTab(tabId);
      } catch (error) {
        console.error('Error getting window ID for tab:', error);
      }
    }

    void chrome.storage.sync
      .get(getOversightStorageQueryDefaults())
      .then((result) => {
        const oversightSettings = mapStorageToOversightSettings(result as Record<string, unknown>);
        const enableAgentFocus = Boolean(oversightSettings[AGENT_FOCUS_MECHANISM_ID]);
        const page = getTabState(tabId)?.page;

        if (enableAgentFocus && page) {
          void waitForOverlayApprovalDecision(page, requestId).then((decision) => {
            if (!decision || !pendingApprovals.has(requestId)) return;
            handleApprovalResponse(requestId, decision.approved);
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

        return handleApprovalRequested({
          stepId,
          requestId,
          tabId,
          windowId,
          page,
          toolName,
          toolInput,
          reason,
          enableAgentFocus,
        });
      })
      .catch((error) => {
        console.warn('Failed to load oversight settings for approval overlay:', error);
        return handleApprovalRequested({
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
      });
    
    // Send approval request to UI with a callback to handle errors
    chrome.runtime.sendMessage({
      action: 'requestApproval',
      tabId,
      windowId, // Include window ID in the message
      requestId,
      stepId,
      toolName,
      toolInput,
      reason
    }, (_response) => {
      // Handle any potential errors
      if (chrome.runtime.lastError) {
        console.error('Error sending approval request:', chrome.runtime.lastError);
        // If there's an error, resolve with false (reject the action)
        resolve(false);
      }
      // Don't resolve here - wait for the handleApprovalResponse call
    });
  });
}

/**
 * Handles an approval response from the UI
 * @param requestId The ID of the approval request
 * @param approved Whether the request was approved
 */
export function handleApprovalResponse(requestId: string, approved: boolean): void {
  const pendingApproval = pendingApprovals.get(requestId);
  if (pendingApproval) {
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
