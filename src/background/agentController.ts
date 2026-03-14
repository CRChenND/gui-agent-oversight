// Import provider-specific types
import Anthropic from "@anthropic-ai/sdk";
import { requestPlanStepApproval } from "../agent/approvalManager";
import { BrowserAgent, createBrowserAgent, executePromptWithFallback, needsReinitialization } from "../agent/AgentCore";
import { ExecutionCallbacks } from "../agent/ExecutionEngine";
import { contextTokenCount } from "../agent/TokenManager";
import { registerThinkingDispatch } from "../agent/thinking/thinkingEmitter";
import { createProvider } from "../models/providers/factory";
import { setCurrentPage } from "../agent/PageContextManager";
import {
  AGENT_FOCUS_MECHANISM_ID,
  DEFAULT_STRUCTURAL_AMPLIFICATION_STEP_DELAY_MS,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  STRUCTURAL_AMPLIFICATION_MECHANISM_ID,
  getOversightParameterStorageQueryDefaults,
  getOversightStorageQueryDefaults,
  getOversightParameterStorageKey,
  mapStorageToOversightParameterSettings,
  mapStorageToOversightSettings,
} from "../oversight/registry";
import { getOversightRuntimeManager } from "../oversight/runtime/runtimeManager";
import { getOversightSessionManager } from "../oversight/session/sessionManager";
import { ScreenshotManager } from "../tracking/screenshotManager";
import { ConfigManager } from "./configManager";
import { getDefaultOversightArchetype, OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY } from "../options/oversightArchetypes";
import {
  handleRiskSignal,
  handleAgentThinking,
  handleRunCancelled,
  handleRunCompleted,
  handleRunFailed,
  setActiveTaskStepContexts,
  handleToolCompleted,
  handleToolFailed,
  handleToolStarted
} from "./oversightManager";
import { 
  resetStreamingState, 
  addToStreamingBuffer, 
  getStreamingBuffer, 
  setStreamingBuffer,
  clearStreamingBuffer, 
  finalizeStreamingSegment, 
  startNewSegment, 
  getCurrentSegmentId, 
  incrementSegmentId,
  signalStreamingComplete
} from "./streamingManager";
import { 
  attachToTab,
  getCurrentTabId, 
  getTabState, 
  setTabState, 
  getWindowForTab, 
  getAgentForWindow, 
  setAgentForWindow,
  getAgentForTab,
  isConnectionHealthy
} from "./tabManager";
import { ProviderType, AgentStatus, AgentStatusInfo, TaskExecutionContext } from "./types";
import { sendUIMessage, logWithTimestamp, handleError } from "./utils";

// Generic message format that works with all providers
interface GenericMessage {
  role: string;
  content: string | any;
}

// Interface for structured message history
interface MessageHistory {
  provider: ProviderType;
  originalRequest: GenericMessage | null;
  conversationHistory: GenericMessage[];
}

export interface PlanProgressAssessment {
  completedCount: number;
  currentStepNumber: number;
  isFullyCompleted: boolean;
  steps: Array<{
    status: 'completed' | 'current' | 'pending';
    reason: string;
  }>;
}

// Define a maximum token budget for conversation history
const MAX_CONVERSATION_TOKENS = 100000; // 100K tokens for conversation history

// Message histories for conversation context (one per window)
const windowMessageHistories = new Map<number, MessageHistory>();

// Map to track agent status by window ID
const agentStatusMap = new Map<number, AgentStatusInfo>();

/**
 * Set the agent status for a window
 * @param windowId The window ID
 * @param status The agent status
 */
export function setAgentStatus(windowId: number, status: AgentStatus): void {
  const current = agentStatusMap.get(windowId);
  const now = Date.now();
  
  agentStatusMap.set(windowId, { 
    status, 
    timestamp: now,
    lastHeartbeat: now
  });
  
  // Log state transitions
  if (!current || current.status !== status) {
    logWithTimestamp(`Agent status transition: ${current?.status || 'undefined'} -> ${status} for window ${windowId}`);
  }
}

/**
 * Update the agent heartbeat for a window
 * @param windowId The window ID
 */
export function updateAgentHeartbeat(windowId: number): void {
  const current = agentStatusMap.get(windowId);
  if (current && current.status === AgentStatus.RUNNING) {
    agentStatusMap.set(windowId, {
      ...current,
      lastHeartbeat: Date.now()
    });
  }
}

/**
 * Get the agent status for a window
 * @param windowId The window ID
 * @returns The agent status info
 */
export function getAgentStatus(windowId: number): AgentStatusInfo {
  return agentStatusMap.get(windowId) || { 
    status: AgentStatus.IDLE, 
    timestamp: Date.now(),
    lastHeartbeat: 0
  };
}

/**
 * Get the current provider type from config
 */
async function getCurrentProvider(): Promise<ProviderType> {
  const configManager = ConfigManager.getInstance();
  const config = await configManager.getProviderConfig();
  return config.provider;
}

async function collectModelText(systemPrompt: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const configManager = ConfigManager.getInstance();
  const providerConfig = await configManager.getProviderConfig();
  if (!providerConfig.apiKey && providerConfig.provider !== 'ollama') {
    throw new Error(`Missing API key for provider: ${providerConfig.provider}`);
  }
  const provider = await createProvider(providerConfig.provider, {
    apiKey: providerConfig.apiKey || (providerConfig.provider === 'ollama' ? 'dummy-key-for-ollama' : ''),
    apiModelId: providerConfig.apiModelId,
    baseUrl: providerConfig.baseUrl,
    thinkingBudgetTokens: providerConfig.thinkingBudgetTokens,
  });

  let text = '';
  const stream = provider.createMessage(systemPrompt, messages);
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
  }
  return text.trim();
}

function parsePlanProgressAssessment(
  rawText: string,
  expectedStepCount: number
): PlanProgressAssessment {
  const defaultAssessment: PlanProgressAssessment = {
    completedCount: 0,
    currentStepNumber: 0,
    isFullyCompleted: false,
    steps: Array.from({ length: expectedStepCount }, () => ({
      status: 'pending',
      reason: 'Assessment unavailable.',
    })),
  };

  const normalized = rawText.trim();
  const jsonStart = normalized.indexOf('{');
  const jsonEnd = normalized.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    return defaultAssessment;
  }

  try {
    const parsed = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1)) as {
      steps?: Array<{ status?: string; reason?: string }>;
      completedCount?: number;
      currentStepNumber?: number;
      isFullyCompleted?: boolean;
    };
    const steps: PlanProgressAssessment['steps'] = Array.from({ length: expectedStepCount }, (_, index) => {
      const incoming = parsed.steps?.[index];
      const status: 'completed' | 'current' | 'pending' =
        incoming?.status === 'completed' || incoming?.status === 'current' || incoming?.status === 'pending'
          ? incoming.status
          : 'pending';
      const reason = typeof incoming?.reason === 'string' && incoming.reason.trim().length > 0
        ? incoming.reason.trim()
        : 'No clear evidence found.';
      return { status, reason };
    });
    const completedCount = steps.filter((step) => step.status === 'completed').length;
    const currentStepNumber = Math.max(
      0,
      Math.min(
        expectedStepCount,
        steps.findIndex((step) => step.status === 'current') + 1
      )
    );
    const isFullyCompleted = expectedStepCount > 0 && completedCount >= expectedStepCount;
    return {
      completedCount,
      currentStepNumber,
      isFullyCompleted,
      steps,
    };
  } catch {
    return defaultAssessment;
  }
}

export async function assessPlanProgress(args: {
  planSteps: string[];
  agentSteps: Array<{
    index: number;
    status: 'active' | 'completed' | 'cancelled' | 'error';
    toolName: string;
    focusLabel: string;
    thinking?: string;
  }>;
}): Promise<PlanProgressAssessment> {
  const planSteps = args.planSteps.map((step) => step.trim()).filter(Boolean);
  const agentSteps = args.agentSteps;
  if (planSteps.length === 0) {
    return { completedCount: 0, currentStepNumber: 0, isFullyCompleted: false, steps: [] };
  }

  const systemPrompt =
    'You are an execution-progress evaluator.\n' +
    'Given a plan and observed agent execution steps, determine plan progress.\n' +
    'Rules:\n' +
    '1) Use only provided evidence.\n' +
    '2) For each plan step return exactly one status: completed | current | pending.\n' +
    '3) "current" means actively being worked on now.\n' +
    '4) Keep reasons concise and evidence-based.\n' +
    '5) Return valid JSON only.';
  const userPrompt = JSON.stringify(
    {
      task: 'Assess plan progress from execution evidence.',
      requiredOutputShape: {
        steps: 'Array<{status: "completed"|"current"|"pending", reason: string}>',
      },
      planSteps: planSteps.map((step, idx) => ({ stepNumber: idx + 1, text: step })),
      agentSteps: agentSteps.map((step) => ({
        index: step.index,
        status: step.status,
        toolName: step.toolName,
        focusLabel: step.focusLabel,
        thinking: step.thinking || '',
      })),
    },
    null,
    2
  );

  const raw = await collectModelText(systemPrompt, [{ role: 'user', content: userPrompt }]);
  return parsePlanProgressAssessment(raw, planSteps.length);
}

export async function updateApprovedPlanGuidance(args: {
  tabId?: number;
  windowId?: number;
  editedPlan: string;
}): Promise<void> {
  const windowId = args.windowId ?? (args.tabId ? getWindowForTab(args.tabId) : undefined);
  if (!windowId) {
    throw new Error('No window available for approved plan update.');
  }

  const agent = getAgentForWindow(windowId);
  if (!agent) {
    throw new Error(`No active agent for window ${windowId}.`);
  }

  const promptManager = (agent as any).promptManager;
  if (typeof (agent as any).updateApprovedPlanGuidanceDuringRun === 'function') {
    (agent as any).updateApprovedPlanGuidanceDuringRun(args.editedPlan || '');
  } else if (promptManager && typeof promptManager.setApprovedPlanGuidance === 'function') {
    promptManager.setApprovedPlanGuidance(args.editedPlan || '');
  } else {
    throw new Error('Prompt manager unavailable for approved plan update.');
  }

  const tabId = args.tabId ?? getCurrentTabId() ?? undefined;
  if (tabId) {
    sendUIMessage('updateOutput', {
      type: 'system',
      content: '✏️ Updated remaining plan guidance. The agent will use this revised plan for next steps.',
    }, tabId, windowId);
  }
}

/**
 * Clear message history for a specific window
 * @param tabId The tab ID to identify the window
 * @param windowId Optional window ID to clear history for
 */
export async function clearMessageHistory(tabId?: number, windowId?: number): Promise<void> {
  // Get the screenshot manager
  const screenshotManager = ScreenshotManager.getInstance();
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  // If windowId is not provided but tabId is, try to get the window ID
  if (tabId && !windowId) {
    windowId = getWindowForTab(tabId);
  }
  
  // If we have a window ID, clear that specific window's history
  if (windowId) {
    // Clear message history for a specific window
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
    // Clear screenshots
    screenshotManager.clear();
    logWithTimestamp(`Message history and screenshots cleared for window ${windowId}`);
  } else if (getCurrentTabId()) {
    // Try to get the window ID for the current tab
    const currentWindowId = getWindowForTab(getCurrentTabId()!);
    if (currentWindowId) {
      // Clear message history for the current window
      windowMessageHistories.set(currentWindowId, { provider, originalRequest: null, conversationHistory: [] });
      // Clear screenshots
      screenshotManager.clear();
      logWithTimestamp(`Message history and screenshots cleared for current window ${currentWindowId}`);
    }
  } else {
    // Clear all message histories if no window ID is specified
    windowMessageHistories.clear();
    // Clear screenshots
    screenshotManager.clear();
    logWithTimestamp("All message histories and screenshots cleared");
  }
}

/**
 * Get message history for a specific window
 * @param tabId The tab ID to identify the window
 * @returns The combined message history for the window (original request + conversation)
 */
export async function getMessageHistory(tabId: number): Promise<Anthropic.MessageParam[]> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot get message history: No window ID found for tab ${tabId}`, 'warn');
    return [];
  }
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  if (!windowMessageHistories.has(windowId)) {
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
  }
  
  const history = windowMessageHistories.get(windowId)!;
  
  // Update provider if it has changed
  if (history.provider !== provider) {
    history.provider = provider;
    windowMessageHistories.set(windowId, history);
  }
  
  // Check if we need to avoid duplication of the first message
  let messagesToConvert: GenericMessage[] = [];
  
  if (history.originalRequest) {
    // Check if the first message in conversationHistory is the same as originalRequest
    const isDuplicate = history.conversationHistory.length > 0 && 
                        history.conversationHistory[0].role === history.originalRequest.role &&
                        history.conversationHistory[0].content === history.originalRequest.content;
    
    if (isDuplicate) {
      // If duplicate, only use conversationHistory
      messagesToConvert = history.conversationHistory;
      logWithTimestamp(`Avoided duplicate first message for tab ${tabId}`);
    } else {
      // If not duplicate, combine originalRequest with conversationHistory
      messagesToConvert = [history.originalRequest, ...history.conversationHistory];
    }
  } else {
    // If no originalRequest, just use conversationHistory
    messagesToConvert = history.conversationHistory;
  }
  
  // Convert generic messages to provider-specific format
  const convertedMessages = convertMessagesToProviderFormat(
    messagesToConvert,
    provider
  );
  
  return convertedMessages;
}

/**
 * Convert generic messages to provider-specific format
 * @param messages The generic messages to convert
 * @param provider The provider to convert to
 * @returns The provider-specific messages
 */
function convertMessagesToProviderFormat(messages: GenericMessage[], provider: ProviderType): Anthropic.MessageParam[] {
  switch (provider) {
    case 'anthropic':
      // Convert to Anthropic format
      return messages.map(msg => {
        // Ensure role is either "user" or "assistant" for Anthropic
        const role = msg.role === "user" || msg.role === "assistant" 
          ? msg.role as "user" | "assistant"
          : "user"; // Default to user for any other role
        
        return {
          role,
          content: msg.content
        };
      });
      
    case 'openai':
      // Convert to OpenAI format (which is compatible with Anthropic's format for our purposes)
      return messages.map(msg => {
        // Map roles: system -> user, user -> user, assistant -> assistant
        const role = msg.role === "assistant" ? "assistant" : "user";
        
        return {
          role,
          content: msg.content
        };
      });
      
    case 'gemini':
      // Convert to Gemini format (which is compatible with Anthropic's format for our purposes)
      return messages.map(msg => {
        // Map roles: system -> user, user -> user, assistant -> assistant
        const role = msg.role === "assistant" ? "assistant" : "user";
        
        return {
          role,
          content: msg.content
        };
      });
      
    case 'ollama':
      // Convert to Ollama format (which is compatible with Anthropic's format for our purposes)
      return messages.map(msg => {
        // Map roles: system -> user, user -> user, assistant -> assistant
        const role = msg.role === "assistant" ? "assistant" : "user";
        
        return {
          role,
          content: msg.content
        };
      });
      
    default:
      // Default to Anthropic format
      return messages.map(msg => {
        const role = msg.role === "user" || msg.role === "assistant" 
          ? msg.role as "user" | "assistant"
          : "user";
        
        return {
          role,
          content: msg.content
        };
      });
  }
}

/**
 * Get the structured message history object for a specific window
 * @param tabId The tab ID to identify the window
 * @returns The structured message history object
 */
export async function getStructuredMessageHistory(tabId: number): Promise<MessageHistory> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot get structured message history: No window ID found for tab ${tabId}`, 'warn');
    // Return an empty history if no window ID is found
    const provider = await getCurrentProvider();
    return { provider, originalRequest: null, conversationHistory: [] };
  }
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  if (!windowMessageHistories.has(windowId)) {
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
  }
  
  const history = windowMessageHistories.get(windowId)!;
  
  // Update provider if it has changed
  if (history.provider !== provider) {
    history.provider = provider;
    windowMessageHistories.set(windowId, history);
  }
  
  return history;
}

/**
 * Set the original request for a specific window
 * @param tabId The tab ID to identify the window
 * @param request The original request message
 */
export async function setOriginalRequest(tabId: number, request: Anthropic.MessageParam): Promise<void> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot set original request: No window ID found for tab ${tabId}`, 'warn');
    return;
  }
  
  const history = await getStructuredMessageHistory(tabId);
  history.originalRequest = request;
  windowMessageHistories.set(windowId, history);
}

/**
 * Add a message to the conversation history for a specific window
 * @param tabId The tab ID to identify the window
 * @param message The message to add
 */
export async function addToConversationHistory(tabId: number, message: Anthropic.MessageParam): Promise<void> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot add to conversation history: No window ID found for tab ${tabId}`, 'warn');
    return;
  }
  
  const history = await getStructuredMessageHistory(tabId);
  history.conversationHistory.push(message);
  windowMessageHistories.set(windowId, history);
}

// No replacement - removing the isNewTaskRequest function

/**
 * Initialize the agent if we have a page and API key
 * @param tabId The tab ID to initialize the agent for
 * @param forceReinit Optional flag to force reinitialization
 * @returns Promise resolving to true if initialization was successful, false otherwise
 */
export async function initializeAgent(tabId: number, forceReinit: boolean = false): Promise<boolean> {
  const tabState = getTabState(tabId);
  
  if (!tabState?.page || !tabState.windowId) {
    return false;
  }
  
  const windowId = tabState.windowId;
  
  // Get provider configuration
  const configManager = ConfigManager.getInstance();
  const providerConfig = await configManager.getProviderConfig();
  
  // Token tracking removed
  
  // Check if we need to initialize or reinitialize the agent
  const existingAgent = getAgentForWindow(windowId);
  const needsInit = !existingAgent || forceReinit;
  const needsReinit = existingAgent && await needsReinitialization(existingAgent, providerConfig);
  
  if (needsInit || needsReinit) {
    try {
      // Make API key optional for Ollama
      if (providerConfig.apiKey || providerConfig.provider === 'ollama') {
        logWithTimestamp(`Creating LLM agent for window ${windowId} with ${providerConfig.provider} provider...`);
        const agent = await createBrowserAgent(tabState.page, providerConfig.apiKey || 'dummy-key-for-ollama');
        
        // Store the agent by window ID
        setAgentForWindow(windowId, agent);
        
        logWithTimestamp(`LLM agent created successfully for window ${windowId}`);
        return true;
      } else {
        logWithTimestamp('No API key found for the selected provider, skipping agent initialization', 'warn');
        return false;
      }
    } catch (agentError) {
      handleError(agentError, 'creating agent');
      return false;
    }
  }
  
  return !!existingAgent;
}

/**
 * Cancel the current execution
 * @param tabId The tab ID to cancel execution for
 */
export function cancelExecution(tabId?: number): void {
  if (!tabId) {
    // If no tab ID provided, try to cancel the current tab's agent
    const currentTabId = getCurrentTabId();
    if (!currentTabId) return;
    tabId = currentTabId;
  }
  
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot cancel execution for tab ${tabId}: no window ID found`);
    return;
  }
  
  // Get the agent for this window
  const agent = getAgentForWindow(windowId);
  if (!agent) {
    logWithTimestamp(`Cannot cancel execution for window ${windowId}: no agent found`);
    return;
  }
  
  // Cancel the agent
  agent.cancel();
  
  // Notify UI
  sendUIMessage('updateOutput', {
    type: 'system',
    content: 'Cancelling execution...'
  }, tabId);

  const tabState = getTabState(tabId);
  void getOversightRuntimeManager().markRunCancelled(windowId);
  void handleRunCancelled({
    tabId,
    windowId,
    page: tabState?.page,
    focusLabel: 'Execution cancelled'
  });
  
  // Immediately notify UI that processing is complete
  sendUIMessage('processingComplete', null, tabId);
  
  // Set agent status to IDLE
  setAgentStatus(windowId, AgentStatus.IDLE);
  
  logWithTimestamp(`Cancelled execution for tab ${tabId} in window ${windowId}`);
}

/**
 * Execute a prompt using the LLM agent
 * @param prompt The prompt to execute
 * @param tabId Optional tab ID to execute the prompt for
 * @param isReflectionPrompt Optional flag to indicate if this is a reflection prompt
 */
export async function executePrompt(
  prompt: string,
  tabId?: number,
  isReflectionPrompt: boolean = false,
  taskContext?: TaskExecutionContext
): Promise<void> {
  try {
    // Get provider configuration from ConfigManager
    const configManager = ConfigManager.getInstance();
    const providerConfig = await configManager.getProviderConfig();
    
    // Make API key optional for Ollama
    if (!providerConfig.apiKey && providerConfig.provider !== 'ollama') {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: API key not found for ${providerConfig.provider}. Please set your API key in the extension options.`
      }, tabId);
      sendUIMessage('processingComplete', null, tabId);
      return;
    }

    // Use the provided tabId if available, otherwise query for the active tab
    let targetTabId = tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = tabs[0]?.id;
    }
    
    if (!targetTabId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: 'Error: Could not determine which tab to use.'
      }, tabId);
      sendUIMessage('processingComplete', null, tabId);
      return;
    }
    
    logWithTimestamp(`Executing prompt for tab ${targetTabId}: "${prompt}"`);
    
    // Get the tab state
    const tabState = getTabState(targetTabId);
    
    // Check if we need to initialize or reattach
    const tabWindowId = tabState?.windowId;
    const needsInitialization = !tabState?.page || !tabWindowId || !getAgentForWindow(tabWindowId);
    const connectionBroken = tabState?.page && !(await isConnectionHealthy(tabState.page));
    
    if (needsInitialization || connectionBroken) {
      // If connection is broken, log it
      if (connectionBroken) {
        logWithTimestamp("Connection health check failed, reattaching...", 'warn');
        sendUIMessage('updateOutput', {
          type: 'system',
          content: 'Debug session was closed, reattaching...'
        }, targetTabId);
      } else {
        sendUIMessage('updateOutput', {
          type: 'system',
          content: 'Initializing for tab...'
        }, targetTabId);
      }
      
      // Attach to the tab
      const attachResult = await attachToTab(targetTabId);
      
      // Check if attachResult is an object with error information
      if (attachResult !== true && attachResult !== false && typeof attachResult === 'object' && 'error' in attachResult) {
        // This is a specific error case with detailed information
        if (attachResult.error === 'unsupported_tab') {
          // Handle unsupported tab error with a specific message
          sendUIMessage('updateOutput', {
            type: 'system',
            content: `Error: ${attachResult.reason} Please try using the extension in a regular web page tab.`
          }, targetTabId);
          sendUIMessage('processingComplete', null, targetTabId);
          return;
        }
      } else if (attachResult === true) {
        // Check if we navigated to google.com
        try {
          const tab = await chrome.tabs.get(targetTabId);
          if (tab && tab.url && tab.url.includes('google.com')) {
            // If the URL contains google.com, we might have auto-navigated there
            sendUIMessage('updateOutput', {
              type: 'system',
              content: 'Note: Navigated to Google to enable extension functionality in this tab.'
            }, targetTabId);
          }
        } catch (error) {
          // Ignore errors checking the tab URL
        }
      }
      // If attachResult is a number, it means a new tab was created
      else if (typeof attachResult === 'number') {
        // Update the target tab ID to the new one
        logWithTimestamp(`Tab ${targetTabId} was replaced with new tab ${attachResult}`);
        targetTabId = attachResult;
      }
      
      await initializeAgent(targetTabId);
    }

    // Get the updated tab state
    const updatedTabState = getTabState(targetTabId);
    
    // If we still don't have a page or window ID, something went wrong
    if (!updatedTabState?.page || !updatedTabState?.windowId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: 'Error: Failed to initialize Playwright or create agent. This may be because you are using the extension in an unsupported tab type.'
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    // Update PageContextManager with the new page
    try {
      setCurrentPage(updatedTabState.page);
      logWithTimestamp(`Updated PageContextManager with page for tab ${targetTabId} in executePrompt`);
    } catch (error) {
      logWithTimestamp(`Error updating PageContextManager in executePrompt: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }

    // Add current page context to history if we have a page
    if (updatedTabState.page) {
      try {
        const currentUrl = await updatedTabState.page.url();
        const currentTitle = await updatedTabState.page.title();
        
        // Set the current page context in the PromptManager
        // This will be included in the system prompt
        const updatedWindowId = updatedTabState.windowId;
        const agent = getAgentForWindow(updatedWindowId);
        if (agent) {
          // Access the PromptManager through the agent
          // This is a bit of a hack since we don't have direct access to the PromptManager
          // We're assuming the agent has a property called promptManager
          const promptManager = (agent as any).promptManager;
          if (promptManager && typeof promptManager.setCurrentPageContext === 'function') {
            promptManager.setCurrentPageContext(currentUrl, currentTitle);
          }
        }
      } catch (error) {
        logWithTimestamp("Could not get current page info: " + String(error), 'warn');
      }
    }
    
    // Execute the prompt
    await getOversightSessionManager().startSession();
    setActiveTaskStepContexts(taskContext?.steps || []);
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `Executing prompt: "${prompt}"`
    }, targetTabId);
    
    // Set agent status to RUNNING if we have a window ID
    if (updatedTabState.windowId) {
      setAgentStatus(updatedTabState.windowId, AgentStatus.RUNNING);
    }
    
    // Always enable streaming
    const useStreaming = true;
    const controlModeKey = getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'controlMode');
    const gatePolicyKey = getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'gatePolicy');
    const planReviewEnabledKey = 'oversight.runtime.planReviewEnabled';
    const mechanismStorage = await chrome.storage.sync.get({
      ...getOversightStorageQueryDefaults(),
      ...getOversightParameterStorageQueryDefaults(),
      [controlModeKey]: 'risky_only',
      [gatePolicyKey]: 'impact',
      [planReviewEnabledKey]: true,
      [OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]: getDefaultOversightArchetype().id,
    });
    const mechanismSettings = mapStorageToOversightSettings(mechanismStorage as Record<string, unknown>);
    const parameterSettings = mapStorageToOversightParameterSettings(mechanismStorage as Record<string, unknown>);
    const enableAgentFocus = mechanismSettings[AGENT_FOCUS_MECHANISM_ID];
    const monitoringParameters = parameterSettings[MONITORING_MECHANISM_ID] || {};
    const interventionParameters = parameterSettings[INTERVENTION_GATE_MECHANISM_ID] || {};
    const structuralParameters = parameterSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID] || {};
    const enableStructuralAmplification =
      mechanismSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID] &&
      structuralParameters.enableStructuralAmplification !== false;
    const rawControlMode = mechanismStorage[controlModeKey];
    const rawGatePolicy = mechanismStorage[gatePolicyKey];
    const controlMode =
      rawControlMode === 'approve_all' || rawControlMode === 'risky_only' || rawControlMode === 'step_through'
        ? rawControlMode
        : 'risky_only';
    const gatePolicy =
      rawGatePolicy === 'never' || rawGatePolicy === 'always' || rawGatePolicy === 'impact' || rawGatePolicy === 'adaptive'
        ? rawGatePolicy
        : 'impact';
    const selectedArchetypeId =
      typeof mechanismStorage[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY] === 'string'
        ? mechanismStorage[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]
        : getDefaultOversightArchetype().id;
    const enableFocusThinkingOverlay =
      enableStructuralAmplification || selectedArchetypeId === 'risk-gated';
    const planReviewEnabled =
      mechanismStorage[planReviewEnabledKey] !== false &&
      selectedArchetypeId !== 'action-confirmation' &&
      selectedArchetypeId !== 'risk-gated';
    const runtimeManager = getOversightRuntimeManager();
    runtimeManager.initializeRun({
      tabId: targetTabId,
      windowId: updatedTabState.windowId,
      controlMode,
      gatePolicy,
      runtimePolicyBaseline: {
        monitoringContentScope:
          monitoringParameters.monitoringContentScope === 'minimal' ||
          monitoringParameters.monitoringContentScope === 'standard' ||
          monitoringParameters.monitoringContentScope === 'full'
            ? monitoringParameters.monitoringContentScope
            : 'standard',
        explanationAvailability:
          monitoringParameters.explanationAvailability === 'none' ||
          monitoringParameters.explanationAvailability === 'summary' ||
          monitoringParameters.explanationAvailability === 'full'
            ? monitoringParameters.explanationAvailability
            : 'summary',
        userActionOptions: interventionParameters.userActionOptions === 'extended' ? 'extended' : 'basic',
        persistenceMs: Math.max(0, Number(monitoringParameters.persistenceMs ?? 0)),
        tightenHighImpactAuthority: false,
      },
      structuralAmplification: {
        enabled:
          mechanismSettings[STRUCTURAL_AMPLIFICATION_MECHANISM_ID] &&
          structuralParameters.enableStructuralAmplification !== false,
        deliberationThreshold: Number(structuralParameters.deliberationThreshold ?? 3),
        signalDecayMs: Number(structuralParameters.signalDecayMs ?? 10000),
        sustainedWindowMs: Number(structuralParameters.sustainedWindowMs ?? 10000),
        resolutionWindowMs: Number(structuralParameters.resolutionWindowMs ?? 15000),
        escalationPersistenceMs: 300000,
      },
    });
    if (!planReviewEnabled) {
      await runtimeManager.setExecutionPhase(updatedTabState.windowId, 'execution', 'plan_review_not_required');
    }
    
    // Reset streaming buffer and segment ID
    resetStreamingState();
    
    // Get the structured message history
    const history = await getStructuredMessageHistory(targetTabId);
    
    // Check if this is the first prompt (no original request yet)
    if (!history.originalRequest) {
      // Store this as the original request without adding any special tag
      await setOriginalRequest(targetTabId, { 
        role: "user", 
        content: prompt 
      });
      
      // Also add it to the conversation history to maintain the flow
      await addToConversationHistory(targetTabId, { 
        role: "user", 
        content: prompt 
      });
      
      logWithTimestamp(`Set original request for tab ${targetTabId}: "${prompt}"`);
    } else {
      // This is a follow-up prompt, add it to conversation history
      await addToConversationHistory(targetTabId, { 
        role: "user", 
        content: prompt 
      });
    }
    
    // Create callbacks for the agent
    let currentToolCall: { stepId: string; toolName: string; toolInput: string } | null = null;
    const latestThinkingByStepId = new Map<string, string>();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const getThinkingTypingDurationMs = (thinking: string) => {
      const normalized = thinking.trim();
      return Math.min(1200, Math.ceil(normalized.length / 8) * 16);
    };

    const callbacks: ExecutionCallbacks = {
      onLlmChunk: (chunk) => {
        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Add chunk to buffer
          addToStreamingBuffer(chunk, targetTabId, windowId);
        }
      },
      onLlmOutput: async (content) => {
        // For non-streaming mode, send the complete output
        if (!useStreaming) {
          sendUIMessage('updateOutput', {
            type: 'llm',
            content: content
          }, targetTabId);
        } else {
          // For streaming mode, store the final content to ensure it's not lost
          // This will be used in onComplete if needed
          setStreamingBuffer(content);
        }
        
        try {
          // Add the assistant's response to conversation history
          await addToConversationHistory(targetTabId, { role: "assistant", content: content });
          
          // Trim conversation history if it exceeds the token budget
          const history = await getStructuredMessageHistory(targetTabId);
          
          // Calculate the current token count of the conversation history
          const conversationTokens = contextTokenCount(history.conversationHistory);
          
          // If we're over budget, trim from the oldest messages until we're under budget
          if (conversationTokens > MAX_CONVERSATION_TOKENS) {
            logWithTimestamp(`Conversation history exceeds token budget (${conversationTokens}/${MAX_CONVERSATION_TOKENS}), trimming oldest messages`);
            
            // Remove oldest messages until we're under the token budget
            while (contextTokenCount(history.conversationHistory) > MAX_CONVERSATION_TOKENS && 
                   history.conversationHistory.length > 1) {
              // Remove the oldest message
              history.conversationHistory.shift();
            }
            
            // Get the window ID for this tab
            const windowId = getWindowForTab(targetTabId);
            if (windowId) {
              // Update the message history
              windowMessageHistories.set(windowId, history);
            }
            
            logWithTimestamp(`Trimmed conversation history to ${history.conversationHistory.length} messages (${contextTokenCount(history.conversationHistory)} tokens)`);
          }
        } catch (error) {
          logWithTimestamp(`Error updating conversation history: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      },
      onToolOutput: (content) => {
        // Normal handling for tool outputs
        sendUIMessage('updateOutput', {
          type: 'system',
          content: content
        }, targetTabId);
      },
      onToolEnd: (stepId, result) => {
        const windowId = getWindowForTab(targetTabId);
        const toolName = currentToolCall?.toolName ?? 'unknown_tool';
        const toolInput = currentToolCall?.toolInput ?? '';
        const resolvedStepId = currentToolCall?.stepId ?? stepId;
        currentToolCall = null;

        void handleToolCompleted({
          tabId: targetTabId,
          windowId,
          stepId: resolvedStepId,
          toolName,
          toolInput,
          result,
        });
        void runtimeManager.registerStepCommitted(windowId);

        // Check if this is a screenshot result by trying to parse it as JSON
        try {
          const data = JSON.parse(result);
          
          // Handle screenshot reference format
          if (data.type === "screenshotRef" && data.id) {
            // Get the screenshot manager
            const screenshotManager = ScreenshotManager.getInstance();
            
            // Get the screenshot data from the manager
            const screenshotData = screenshotManager.getScreenshot(data.id);
            
            if (screenshotData && 
                screenshotData.source && 
                screenshotData.source.data) {
              
              // Send special screenshot message to UI
              sendUIMessage('updateScreenshot', {
                type: 'screenshot',
                content: data.note || "Screenshot captured",
                imageData: screenshotData.source.data,
                mediaType: screenshotData.source.media_type || 'image/jpeg'
              }, targetTabId);
              
              logWithTimestamp(`Sent screenshot ${data.id} to UI for tab ${targetTabId}`);
            } else {
              logWithTimestamp(`Screenshot data not found for ID ${data.id}`, 'warn');
            }
          }
        } catch (error) {
          // Not JSON or not a screenshot, ignore
        }
      },
      onToolError: (stepId, toolName, toolInput, error) => {
        const windowId = getWindowForTab(targetTabId);
        currentToolCall = null;
        void handleToolFailed({
          tabId: targetTabId,
          windowId,
          stepId,
          toolName,
          toolInput,
          error,
        });
      },
      onRiskSignal: (stepId, toolName, signal) => {
        const windowId = getWindowForTab(targetTabId);
        void runtimeManager.handleAdaptiveRiskSignal({
          windowId,
          gatePolicy: typeof signal.gatePolicy === 'string' ? signal.gatePolicy : undefined,
          promptedByGate: Boolean(signal.promptedByGate),
          impact: typeof signal.impact === 'string' ? signal.impact : undefined,
        });
        void handleRiskSignal({
          tabId: targetTabId,
          windowId,
          stepId,
          toolName,
          signal,
        });
      },
      onError: (error) => {
        // For retryable errors (rate limit or overloaded), show a message but don't complete processing
        if (error?.error?.type === 'rate_limit_error' || error?.error?.type === 'overloaded_error') {
          const errorType = error?.error?.type === 'overloaded_error' ? 'Anthropic servers overloaded' : 'Rate limit exceeded';
          logWithTimestamp(`${errorType} error detected: ${JSON.stringify(error)}`, 'warn');
          
          sendUIMessage('updateOutput', {
            type: 'system',
            content: `⚠️ ${errorType}. Retrying... (${error.error.message})`
          }, targetTabId);
          
          // Explicitly tell the UI to stay in processing mode
          sendUIMessage('rateLimit', {
            isRetrying: true
          }, targetTabId);
        }
      },
      onFallbackStarted: () => {
        // Notify the UI that we're falling back but still processing
        logWithTimestamp("Fallback started, notifying UI to maintain processing state");
        sendUIMessage('fallbackStarted', {
          message: "Switching to fallback mode due to error. Processing continues..."
        }, targetTabId);
        
        // Explicitly tell the UI to stay in processing mode
        sendUIMessage('rateLimit', {
          isRetrying: true
        }, targetTabId);
      },
      onPlanGenerated: ({ summary, steps }) => {
        if (selectedArchetypeId !== 'supervisory-co-execution') return;
      },
      onSegmentComplete: (segment) => {
        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Finalize the current streaming segment
          finalizeStreamingSegment(getCurrentSegmentId(), segment, targetTabId, windowId);
          
          // Increment segment ID for the next segment
          incrementSegmentId();
        }
      },
      onToolStart: (stepId, toolName, toolInput, planStepIndex, stepDescription) => {
        currentToolCall = { stepId, toolName, toolInput };
        void handleToolStarted({
          tabId: targetTabId,
          windowId: updatedTabState.windowId,
          page: updatedTabState.page,
          stepId,
          toolName,
          toolInput,
          planStepIndex,
          stepDescription,
          enableAgentFocus,
          thinking: latestThinkingByStepId.get(stepId) || '',
          enableThinkingOverlay: enableFocusThinkingOverlay,
          selectedArchetypeId,
        });

        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Start a new segment for after the tool execution
          startNewSegment(getCurrentSegmentId(), targetTabId, windowId);
        }
      },
      onAfterToolStart: async ({ stepId, thinking }) => {
        if (!enableStructuralAmplification) return;
        const resolvedThinking = (thinking || latestThinkingByStepId.get(stepId) || '').trim();
        const totalDelayMs = Math.min(
          2200,
          getThinkingTypingDurationMs(resolvedThinking) + Math.min(DEFAULT_STRUCTURAL_AMPLIFICATION_STEP_DELAY_MS, 1000)
        );
        await wait(totalDelayMs);
      },
      onComplete: (result) => {
        // Get the window ID for this tab
        const windowId = getWindowForTab(targetTabId);
        if (result?.status === 'completed' || !result) {
          void runtimeManager.markRunCompleted(windowId);
          void handleRunCompleted({
            tabId: targetTabId,
            windowId,
            page: updatedTabState.page,
            focusLabel: 'Task completed'
          });
        } else if (result.status === 'cancelled') {
          void runtimeManager.markRunCancelled(windowId);
          void handleRunCancelled({
            tabId: targetTabId,
            windowId,
            page: updatedTabState.page,
            focusLabel: result.reason || 'Execution cancelled'
          });
        } else {
          void runtimeManager.markRunFailed(windowId);
          void handleRunFailed({
            tabId: targetTabId,
            windowId,
            page: updatedTabState.page,
            focusLabel: result.status === 'max_steps' ? 'Execution stopped' : 'Execution stopped',
            error: result.reason || 'Execution stopped before task completion.',
          });
        }
        
        // Finalize the last segment if needed FIRST
        // This ensures the final LLM output is not lost
        if (useStreaming && getStreamingBuffer().trim()) {
          // Check if this segment contains a tool call
          const hasToolCall = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>/.test(getStreamingBuffer());
          
          // If it doesn't have a tool call, it's likely the final output
          if (!hasToolCall) {
            finalizeStreamingSegment(getCurrentSegmentId(), getStreamingBuffer(), targetTabId, windowId);
          }
        }
        
        // THEN clear any remaining buffer
        clearStreamingBuffer(targetTabId, windowId);
        
        // Signal that streaming is complete
        if (useStreaming) {
          signalStreamingComplete(targetTabId, windowId);
        }
        
        // Set agent status to IDLE
        if (windowId) {
          setAgentStatus(windowId, AgentStatus.IDLE);
        }
        
        sendUIMessage('processingComplete', null, targetTabId, windowId);
      },
      onPlanReviewRequired: planReviewEnabled
        ? async (payload) => {
            const windowId = getWindowForTab(targetTabId);
            return runtimeManager.requestPlanReview(windowId, payload);
          }
        : undefined,
      onPlanStepApprovalRequired:
        selectedArchetypeId === 'supervisory-co-execution'
          ? async (payload) => {
              const approved = await requestPlanStepApproval(
                targetTabId,
                payload.stepId,
                payload.planStepIndex + 1,
                payload.planStepText,
                updatedTabState.windowId
              );
              return { decision: approved ? 'accept' as const : 'reject' as const };
            }
          : undefined,
      onWaitForExecutionPermission: async () => {
        const windowId = getWindowForTab(targetTabId);
        return runtimeManager.waitUntilExecutable(windowId);
      },
      onPrepareModelStep: async () => {
        const windowId = getWindowForTab(targetTabId);
        const amplification = runtimeManager.getAmplificationStatus(windowId);
        return {
          amplificationState: amplification.state,
          enteredReason: amplification.enteredReason,
          executionProfile:
            selectedArchetypeId === 'structural-amplification'
              ? 'structural_amplification' as const
              : selectedArchetypeId === 'supervisory-co-execution'
                ? 'supervisory_coexecution' as const
              : selectedArchetypeId === 'action-confirmation'
                ? 'action_confirmation' as const
              : 'default' as const,
        };
      },
      onBeforeToolInvocation: async ({ stepId, toolName }) => {
        const windowId = getWindowForTab(targetTabId);
        return runtimeManager.waitForSoftPauseWindow({
          windowId,
          stepId,
          toolName,
        });
      },
      classifyAmplifiedRisk: ({ toolName, toolInput }) => {
        const windowId = getWindowForTab(targetTabId);
        return runtimeManager.classifyAmplifiedRisk({ windowId, toolName, toolInput });
      },
    };

    registerThinkingDispatch((event) => {
      if (event.kind !== 'agent_thinking') return;
      latestThinkingByStepId.set(event.stepId, event.thinking.rationale || event.thinking.goal || '');
      void handleAgentThinking({
        tabId: targetTabId,
        windowId: updatedTabState.windowId,
        stepId: event.stepId,
        toolName: event.toolName,
        thinking: event.thinking,
      });
    });
    
    // Get the agent for this window
    const updatedWindowId = updatedTabState.windowId;
    if (!updatedWindowId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: No window ID found for tab ${targetTabId}.`
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    const agent = getAgentForWindow(updatedWindowId);
    
    if (!agent) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: No agent found for window ${updatedWindowId}.`
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    // Execute the prompt with the agent
    const messageHistory = await getMessageHistory(targetTabId);
    await executePromptWithFallback(
      agent, 
      prompt, 
      callbacks, 
      messageHistory
    );
  } catch (error) {
    const errorMessage = handleError(error, 'executing prompt');
    if (tabId) {
      void getOversightRuntimeManager().markRunFailed(getWindowForTab(tabId));
      const tabState = getTabState(tabId);
      void handleRunFailed({
        tabId,
        windowId: getWindowForTab(tabId),
        page: tabState?.page,
        focusLabel: 'Execution failed',
        error: errorMessage
      });
    }
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `Error: ${errorMessage}`
    }, tabId);
    sendUIMessage('processingComplete', null, tabId);
  }
}
