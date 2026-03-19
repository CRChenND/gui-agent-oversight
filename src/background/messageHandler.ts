import { clearApprovalSeries, handleApprovalResponse } from '../agent/approvalManager';
import { executePrompt } from './agentController';
import { cancelExecution } from './agentController';
import { clearMessageHistory } from './agentController';
import { initializeAgent } from './agentController';
import { assessPlanProgress } from './agentController';
import { getAgentStatus, updateApprovedPlanGuidance } from './agentController';
import { attachToTab, getTabState, getWindowForTab, forceResetPlaywright } from './tabManager';
import { clearAttentionOverlay, resolveApprovalOverlay } from './attentionTracker';
import { getOversightRuntimeManager } from '../oversight/runtime/runtimeManager';
import { BackgroundMessage } from './types';
import { logWithTimestamp, handleError, sendUIMessage } from './utils';

/**
 * Handle messages from the UI
 * @param message The message to handle
 * @param sender The sender of the message
 * @param sendResponse The function to send a response
 * @returns True if the message was handled, false otherwise
 */
export function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  try {
    // Type guard to check if the message is a valid background message
    if (!isBackgroundMessage(message)) {
      logWithTimestamp(`Ignoring unknown message type: ${JSON.stringify(message)}`, 'warn');
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
    }

    // Handle the message based on its action
    switch (message.action) {
      case 'executePrompt':
        handleExecutePrompt(message, sendResponse);
        return true; // Keep the message channel open for async response

      case 'cancelExecution':
        handleCancelExecution(message, sendResponse);
        return true;

      case 'clearHistory':
        // Handle async function and keep message channel open
        handleClearHistory(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'clearing history');
            logWithTimestamp(`Error in async handleClearHistory: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response

      case 'initializeTab':
        // This function uses setTimeout internally to handle async operations
        // We still return true to keep the message channel open
        handleInitializeTab(message, sendResponse);
        return true; // Keep the message channel open for async response
        
      case 'switchToTab':
        handleSwitchToTab(message, sendResponse);
        return true;
        
      // token usage UI removed
        
      case 'approvalResponse':
        handleApprovalResponseMessage(message, sendResponse);
        return true;
        
      case 'updateOutput':
        // Just pass through output updates
        // This allows components to send UI updates
        sendResponse({ success: true });
        return true;
        
      case 'providerConfigChanged':
        // Just pass through provider configuration change notifications
        // This allows the ProviderSelector component to refresh
        sendResponse({ success: true });
        return true;
        
      case 'oversightEvent':
        // Pass-through for oversight event broadcasts sent from background to UI.
        sendResponse({ success: true });
        return true;
        
      case 'forceResetPlaywright':
        // Handle async function and keep message channel open
        handleForceResetPlaywright(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'force resetting Playwright');
            logWithTimestamp(`Error in async handleForceResetPlaywright: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response
        
      case 'requestApproval':
        // Just acknowledge receipt of the request approval message
        // The actual approval handling is done by the UI
        sendResponse({ success: true });
        return true;
        
      case 'checkAgentStatus':
        // Handle async function and keep message channel open
        handleCheckAgentStatus(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'checking agent status');
            logWithTimestamp(`Error in async handleCheckAgentStatus: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response
      case 'pauseExecution':
        handlePauseExecution(message, sendResponse);
        return true;
      case 'resumeExecution':
        handleResumeExecution(message, sendResponse);
        return true;
      case 'takeoverAuthority':
        handleTakeoverAuthority(message, sendResponse);
        return true;
      case 'releaseControl':
        handleReleaseControl(message, sendResponse);
        return true;
      case 'resolveEscalation':
        handleResolveEscalation(message, sendResponse);
        return true;
      case 'planReviewDecision':
        handlePlanReviewDecision(message, sendResponse);
        return true;
      case 'updateApprovedPlan':
        handleUpdateApprovedPlan(message, sendResponse);
        return true;
      case 'runtimeInteractionSignal':
        handleRuntimeInteractionSignal(message, sendResponse);
        return true;
      case 'softPauseDecision':
        handleSoftPauseDecision(message, sendResponse);
        return true;
      case 'exitAmplifiedMode':
        handleExitAmplifiedMode(message, sendResponse);
        return true;
      case 'assessPlanProgress':
        handleAssessPlanProgress(message, sendResponse);
        return true;

      default:
        // This should never happen due to the type guard, but TypeScript requires it
        logWithTimestamp(`Unhandled message action: ${(message as any).action}`, 'warn');
        sendResponse({ success: false, error: 'Unhandled message action' });
        return false;
    }
  } catch (error) {
    const errorMessage = handleError(error, 'handling message');
    logWithTimestamp(`Error handling message: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
    return false;
  }
}

function handleApprovalResponseMessage(
  message: { requestId: string; approved: boolean; approvalMode?: 'once' | 'series' | 'site'; tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  console.info('[approval-debug] Background received approvalResponse', message);
  const runtimeManager = getOversightRuntimeManager();
  let resolvedWindowId = message.windowId;
  if (typeof resolvedWindowId !== 'number' && typeof message.tabId === 'number') {
    try {
      resolvedWindowId = getWindowForTab(message.tabId);
    } catch {
      resolvedWindowId = undefined;
    }
  }

  const clearResolvedApproval = () => {
    if (!message.tabId) return;
    const page = getTabState(message.tabId)?.page;
    if (page) {
      void resolveApprovalOverlay(page, message.requestId).catch((error) => {
        logWithTimestamp(
          `Failed to resolve approval overlay after approval response: ${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
      });
    }
  };

  const finalize = () => {
    const resolved = handleApprovalResponse(message.requestId, message.approved, message.approvalMode || 'once');
    if (!resolved) {
      sendResponse({ success: true, ignored: true });
      return;
    }

    console.info('[approval-debug] Background finalizing approvalResponse', {
      requestId: message.requestId,
      approved: message.approved,
      approvalMode: message.approvalMode || 'once',
      resolvedWindowId,
    });
    clearResolvedApproval();
    if (message.tabId) {
      const page = getTabState(message.tabId)?.page;
      if (page) {
        void clearAttentionOverlay(page).catch((error) => {
          logWithTimestamp(
            `Failed to clear attention overlay after approval response: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
          );
        });
      }
    }
    sendUIMessage(
      'approvalResolved',
      {
        requestId: message.requestId,
        approved: message.approved,
      },
      message.tabId,
      resolvedWindowId
    );
    sendResponse({ success: true });
  };

  if (!message.approved) {
    const resolved = handleApprovalResponse(message.requestId, message.approved, message.approvalMode || 'once');
    if (!resolved) {
      sendResponse({ success: true, ignored: true });
      return;
    }

    void runtimeManager
      .pauseForRejectedAction(resolvedWindowId, 'approval_rejected')
      .then(() => {
        clearResolvedApproval();
        if (message.tabId) {
          const page = getTabState(message.tabId)?.page;
          if (page) {
            void clearAttentionOverlay(page).catch((error) => {
              logWithTimestamp(
                `Failed to clear attention overlay after approval response: ${error instanceof Error ? error.message : String(error)}`,
                'warn'
              );
            });
          }
        }
        sendUIMessage(
          'approvalResolved',
          {
            requestId: message.requestId,
            approved: message.approved,
          },
          message.tabId,
          resolvedWindowId
        );
        sendResponse({ success: true });
      })
      .catch((error) => {
        logWithTimestamp(`Failed to pause runtime after rejection: ${String(error)}`, 'warn');
        clearResolvedApproval();
        if (message.tabId) {
          const page = getTabState(message.tabId)?.page;
          if (page) {
            void clearAttentionOverlay(page).catch((overlayError) => {
              logWithTimestamp(
                `Failed to clear attention overlay after approval response: ${overlayError instanceof Error ? overlayError.message : String(overlayError)}`,
                'warn'
              );
            });
          }
        }
        sendUIMessage(
          'approvalResolved',
          {
            requestId: message.requestId,
            approved: message.approved,
          },
          message.tabId,
          resolvedWindowId
        );
        sendResponse({ success: true });
      });
    return;
  }

  finalize();
}

/**
 * Type guard to check if a message is a valid background message
 * @param message The message to check
 * @returns True if the message is a valid background message, false otherwise
 */
function isBackgroundMessage(message: any): message is BackgroundMessage {
  return (
    message &&
    typeof message === 'object' &&
    'action' in message &&
    (
      message.action === 'executePrompt' ||
      message.action === 'cancelExecution' ||
      message.action === 'clearHistory' ||
      message.action === 'initializeTab' ||
      message.action === 'switchToTab' ||
      message.action === 'approvalResponse' ||
      message.action === 'updateOutput' ||  // Add support for output updates
      message.action === 'providerConfigChanged' ||  // Add support for provider config changes
      message.action === 'oversightEvent' ||
      message.action === 'tabStatusChanged' ||
      message.action === 'targetCreated' ||
      message.action === 'targetDestroyed' ||
      message.action === 'targetChanged' ||
      message.action === 'tabTitleChanged' ||
      message.action === 'pageDialog' ||
      message.action === 'pageConsole' ||
      message.action === 'pageError' ||
      message.action === 'forceResetPlaywright' ||
      message.action === 'requestApproval' ||  // Add support for request approval messages
      message.action === 'checkAgentStatus' ||  // Add support for agent status check
      message.action === 'pauseExecution' ||
      message.action === 'resumeExecution' ||
      message.action === 'takeoverAuthority' ||
      message.action === 'releaseControl' ||
      message.action === 'resolveEscalation' ||
      message.action === 'planReviewDecision' ||
      message.action === 'updateApprovedPlan' ||
      message.action === 'runtimeInteractionSignal' ||
      message.action === 'softPauseDecision' ||
      message.action === 'exitAmplifiedMode' ||
      message.action === 'assessPlanProgress'
    )
  );
}

function handleAssessPlanProgress(
  message: {
    tabId?: number;
    windowId?: number;
    planSteps?: string[];
    agentSteps?: Array<{
      index: number;
      status: 'active' | 'completed' | 'cancelled' | 'error';
      toolName: string;
      focusLabel: string;
      thinking?: string;
    }>;
  },
  sendResponse: (response?: any) => void
): void {
  if (!Array.isArray(message.planSteps) || !Array.isArray(message.agentSteps)) {
    sendResponse({ success: false, error: 'Missing planSteps or agentSteps' });
    return;
  }
  void assessPlanProgress({
    planSteps: message.planSteps,
    agentSteps: message.agentSteps,
  })
    .then((assessment) => sendResponse({ success: true, assessment }))
    .catch((error) => sendResponse({ success: false, error: String(error) }));
}

function handlePauseExecution(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager.pauseByUser(message.windowId).then(() => sendResponse({ success: true }));
}

function handleResumeExecution(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager.resumeByUser(message.windowId).then(() => sendResponse({ success: true }));
}

function handleTakeoverAuthority(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager.takeover(message.windowId).then(() => sendResponse({ success: true }));
}

function handleReleaseControl(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager.releaseControl(message.windowId).then(() => sendResponse({ success: true }));
}

function handleResolveEscalation(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager.resolveEscalation(message.windowId).then(() => sendResponse({ success: true }));
}

function handlePlanReviewDecision(
  message: { windowId?: number; decision?: 'approve' | 'edit' | 'reject'; editedPlan?: string },
  sendResponse: (response?: any) => void
): void {
  if (!message.decision) {
    sendResponse({ success: false, error: 'Missing plan review decision' });
    return;
  }
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager
    .submitPlanReviewDecision({
      windowId: message.windowId,
      decision: message.decision,
      editedPlan: message.editedPlan,
    })
    .then((resolved) => sendResponse({ success: resolved }))
    .catch((error) => sendResponse({ success: false, error: String(error) }));
}

function handleUpdateApprovedPlan(
  message: { tabId?: number; windowId?: number; editedPlan?: string },
  sendResponse: (response?: any) => void
): void {
  void updateApprovedPlanGuidance({
      tabId: message.tabId,
      windowId: message.windowId,
      editedPlan: typeof message.editedPlan === 'string' ? message.editedPlan : '',
    })
    .then(() => sendResponse({ success: true }))
    .catch((error) => {
      const errorMessage = handleError(error, 'updating approved plan');
      sendResponse({ success: false, error: errorMessage });
    });
}

function handleRuntimeInteractionSignal(
  message: {
    tabId?: number;
    windowId?: number;
    signal?:
      | 'pause_by_user'
      | 'resume_by_user'
      | 'inspect_plan'
      | 'takeover'
      | 'expand_trace_node'
      | 'hover_risk_label'
      | 'open_oversight_tab'
      | 'edit_intermediate_output'
      | 'repeated_scroll_backward'
      | 'repeated_trace_expansion';
    durationMs?: number;
  },
  sendResponse: (response?: any) => void
): void {
  if (!message.signal) {
    sendResponse({ success: false, error: 'Missing runtime interaction signal' });
    return;
  }
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager
    .handleBehavioralSignal({
      windowId: message.windowId,
      signal: message.signal,
      durationMs: typeof message.durationMs === 'number' ? message.durationMs : undefined,
      source: 'ui',
    })
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({ success: false, error: String(error) }));
}

function handleSoftPauseDecision(
  message: {
    tabId?: number;
    windowId?: number;
    decision?: 'continue_now' | 'pause';
  },
  sendResponse: (response?: any) => void
): void {
  if (message.decision !== 'continue_now' && message.decision !== 'pause') {
    sendResponse({ success: false, error: 'Missing soft pause decision' });
    return;
  }
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager
    .resolveSoftPauseDecision(message.windowId, message.decision)
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({ success: false, error: String(error) }));
}

function handleExitAmplifiedMode(
  message: { tabId?: number; windowId?: number },
  sendResponse: (response?: any) => void
): void {
  const runtimeManager = getOversightRuntimeManager();
  void runtimeManager
    .exitAmplifiedMode(message.windowId, 'explicit_exit')
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({ success: false, error: String(error) }));
}

/**
 * Handle the executePrompt message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleExecutePrompt(
  message: Extract<BackgroundMessage, { action: 'executePrompt' }>,
  sendResponse: (response?: any) => void
): void {
  clearApprovalSeries();
  // Use the tabId from the message if available
  if (message.tabId) {
    executePrompt(message.prompt, message.tabId, false, message.taskContext);
  } else {
    executePrompt(message.prompt, undefined, false, message.taskContext);
  }
  sendResponse({ success: true });
}

/**
 * Handle the cancelExecution message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleCancelExecution(
  message: Extract<BackgroundMessage, { action: 'cancelExecution' }>,
  sendResponse: (response?: any) => void
): void {
  cancelExecution(message.tabId);
  clearApprovalSeries();
  sendResponse({ success: true });
}

/**
 * Handle the clearHistory message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleClearHistory(
  message: Extract<BackgroundMessage, { action: 'clearHistory' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  await clearMessageHistory(message.tabId, message.windowId);
  clearApprovalSeries();

  sendResponse({ success: true });
}

/**
 * Handle the initializeTab message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleInitializeTab(
  message: Extract<BackgroundMessage, { action: 'initializeTab' }>,
  sendResponse: (response?: any) => void
): void {
  // Initialize the tab as soon as the side panel is opened
  if (message.tabId) {
    // Use setTimeout to make this asynchronous and return the response immediately
    setTimeout(async () => {
      try {
        // Get the tab title before attaching
        let tabTitle = "Unknown Tab";
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (tab && tab.title) {
            tabTitle = tab.title;
          }
        } catch (titleError) {
          handleError(titleError, 'getting tab title');
        }
        
        await attachToTab(message.tabId, message.windowId);
        await initializeAgent(message.tabId);
        
        // Get the tab state to check if attachment was successful
        const tabState = getTabState(message.tabId);
        if (tabState) {
          // Send a message back to the side panel with the tab title
          chrome.runtime.sendMessage({
            action: 'updateOutput',
            content: {
              type: 'system',
              content: `Connected to tab: ${tabState.title || tabTitle}`
            },
            tabId: message.tabId,
            windowId: tabState.windowId
          });
        }
        
        logWithTimestamp(`Tab ${message.tabId} in window ${message.windowId || 'unknown'} initialized from side panel`);
      } catch (error) {
        handleError(error, 'initializing tab from side panel');
      }
    }, 0);
  }
  sendResponse({ success: true });
}

/**
 * Handle the switchToTab message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleSwitchToTab(
  message: Extract<BackgroundMessage, { action: 'switchToTab' }>,
  sendResponse: (response?: any) => void
): void {
  if (message.tabId) {
    // Get the window ID for this tab if available
    const windowId = getWindowForTab(message.tabId);
    
    // Focus the window first if we have a window ID
    if (windowId) {
      chrome.windows.update(windowId, { focused: true });
    }
    
    // Then focus the tab
    chrome.tabs.update(message.tabId, { active: true });
    
    logWithTimestamp(`Switched to tab ${message.tabId} in window ${windowId || 'unknown'}`);
  }
  sendResponse({ success: true });
}

/**
 * Handle the forceResetPlaywright message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleForceResetPlaywright(
  message: Extract<BackgroundMessage, { action: 'forceResetPlaywright' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    logWithTimestamp('Force resetting Playwright instance');
    
    // Call the forceResetPlaywright function from tabManager
    const result = await forceResetPlaywright();
    
    // Get the current tab and window ID if possible
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;
    const windowId = tabs[0]?.windowId;
    
    // Notify UI components about the reset
    chrome.runtime.sendMessage({
      action: 'updateOutput',
      content: {
        type: 'system',
        content: `Playwright instance has been force reset. ${result ? 'Success' : 'Failed'}`
      },
      tabId,
      windowId
    });
    
    sendResponse({ success: result });
  } catch (error) {
    const errorMessage = handleError(error, 'force resetting Playwright instance');
    logWithTimestamp(`Error force resetting Playwright instance: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

/**
 * Handle the checkAgentStatus message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleCheckAgentStatus(
  message: Extract<BackgroundMessage, { action: 'checkAgentStatus' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    // Get the window ID for this tab
    const windowId = message.windowId || (message.tabId ? getWindowForTab(message.tabId) : null);
    
    if (!windowId) {
      logWithTimestamp(`Cannot check agent status: No window ID found for tab ${message.tabId}`, 'warn');
      sendResponse({ success: false, error: 'No window ID found' });
      return;
    }
    
    const status = getAgentStatus(windowId);
    
    // Send the status back to the UI
    chrome.runtime.sendMessage({
      action: 'agentStatusUpdate',
      status: status.status,
      timestamp: status.timestamp,
      lastHeartbeat: status.lastHeartbeat,
      tabId: message.tabId,
      windowId
    });
    
    sendResponse({ success: true });
  } catch (error) {
    const errorMessage = handleError(error, 'checking agent status');
    logWithTimestamp(`Error checking agent status: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

/**
 * Set up message listeners
 */
export function setupMessageListeners(): void {
  chrome.runtime.onMessage.addListener(handleMessage);
}
