import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigManager } from '../background/configManager';
import {
  BUILTIN_OVERSIGHT_ARCHETYPES,
  cloneArchetypeState,
  getDefaultOversightArchetype,
  getOversightArchetypeById,
  OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY,
} from '../options/oversightArchetypes';
import {
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  buildOversightParameterStoragePatch,
  buildOversightStoragePatch,
  createDefaultOversightParameterSettings,
  createDefaultOversightMechanismSettings,
  getOversightParameterStorageQueryDefaults,
  getOversightStorageQueryDefaults,
  mapStorageToOversightParameterSettings,
  mapStorageToOversightSettings,
} from '../oversight/registry';
import type { AuthorityState, ExecutionPhase, ExecutionState, OversightRegime } from '../oversight/runtime/types';
import { ApprovalRequest } from './components/ApprovalRequest';
import { MessageDisplay } from './components/MessageDisplay';
import { OutputHeader } from './components/OutputHeader';
import { PromptForm } from './components/PromptForm';
import { SupervisoryPlanBlocks } from './components/SupervisoryPlanBlocks';
import { TaskExecutionGraph } from './components/TaskExecutionGraph';
import { badgeClassName } from './components/badgeStyles';
import { useChromeMessaging } from './hooks/useChromeMessaging';
import { useMessageManagement } from './hooks/useMessageManagement';
import { useOversightMechanisms } from './hooks/useOversightMechanisms';
import { useTabManagement } from './hooks/useTabManagement';
import { stripToolMarkup } from './utils/toolMarkup';

export function SidePanel() {
  const [activePanel, setActivePanel] = useState<'conversation' | 'oversight'>('conversation');
  const [selectedArchetypeId, setSelectedArchetypeId] = useState(getDefaultOversightArchetype().id);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [mechanismSettings, setMechanismSettings] = useState(createDefaultOversightMechanismSettings);
  const [mechanismParameterSettings, setMechanismParameterSettings] = useState(createDefaultOversightParameterSettings);
  const [isApplyingArchetype, setIsApplyingArchetype] = useState(false);

  // State for tab status
  const [tabStatus, setTabStatus] = useState<'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error'>('unknown');

  // State for approval requests
  const [approvalRequests, setApprovalRequests] = useState<Array<{
    requestId: string;
    stepId?: string;
    toolName: string;
    toolInput: string;
    reason: string;
    approvalVariant?: 'default' | 'action-confirmation' | 'supervisory' | 'supervisory-plan-step';
    planStepIndex?: number;
  }>>([]);
  const [haltReason, setHaltReason] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<{
    authorityState: AuthorityState;
    executionPhase: ExecutionPhase;
    executionState: ExecutionState;
    regime: OversightRegime;
    amplification?: {
      state: 'normal' | 'amplified';
      enteredAt?: number;
      enteredReason?: 'pause_resume_rapid' | 'inspect_plan' | 'rapid_trace_inspection';
      entryCount: number;
    };
    softPause?: {
      active: boolean;
      startedAt: number;
      endsAt: number;
      timeoutMs: number;
      stepId?: string;
      toolName?: string;
    };
    deliberation?: {
      score: number;
      lastSignalTimestamp: number;
      sustainedDurationMs: number;
      isDeliberative: boolean;
    };
    runtimePolicy?: {
      monitoringContentScope: 'minimal' | 'standard' | 'full';
      explanationAvailability: 'none' | 'summary' | 'full';
      userActionOptions: 'basic' | 'extended';
      persistenceMs: number;
      tightenHighImpactAuthority: boolean;
    };
    updatedAt?: number;
  }>({
    authorityState: 'agent_autonomous',
    executionPhase: 'planning',
    executionState: 'running',
    regime: 'baseline',
    amplification: {
      state: 'normal',
      entryCount: 0,
    },
  });
  const [planReviewRequest, setPlanReviewRequest] = useState<{
    planSummary: string;
    plan?: string[];
    stepId?: string;
    toolName?: string;
    toolInput?: string;
  } | null>(null);
  const [approvedPlan, setApprovedPlan] = useState<{
    summary: string;
    steps: string[];
  } | null>(null);
  const [inspectPlanProgress, setInspectPlanProgress] = useState<{
    completedCount: number;
    currentStepNumber: number;
    isFullyCompleted: boolean;
    steps: Array<{ status: 'completed' | 'current' | 'pending'; reason: string }>;
  } | null>(null);
  const [inspectPlanLoading, setInspectPlanLoading] = useState(false);
  const [inspectPlanError, setInspectPlanError] = useState<string | null>(null);
  const [editedPlanSteps, setEditedPlanSteps] = useState<string[]>([]);
  const [editingRemainingPlan, setEditingRemainingPlan] = useState(false);
  const [showInspectPlanModal, setShowInspectPlanModal] = useState(false);
  const [remainingPlanDraftSteps, setRemainingPlanDraftSteps] = useState<string[]>([]);
  const [draggedPlanStepIndex, setDraggedPlanStepIndex] = useState<number | null>(null);
  const [draggedRemainingStepIndex, setDraggedRemainingStepIndex] = useState<number | null>(null);
  const [editingPlanStepIndex, setEditingPlanStepIndex] = useState<number | null>(null);
  const [editingRemainingStepIndex, setEditingRemainingStepIndex] = useState<number | null>(null);
  const [supervisoryPlanStepOriginals, setSupervisoryPlanStepOriginals] = useState<Record<string, string>>({});
  const [planStepUpdateRequestId, setPlanStepUpdateRequestId] = useState<string | null>(null);
  const [supervisoryActualSteps, setSupervisoryActualSteps] = useState<Array<{
    stepId: string;
    toolName: string;
    focusLabel: string;
    thinking?: string;
    stepDescription?: string;
    planStepIndex?: number;
    timestamp: number;
  }>>([]);
  const [showApprovalOverlay, setShowApprovalOverlay] = useState(true);
  const [softPauseNow, setSoftPauseNow] = useState(Date.now());
  const [thinkingTooltipRect, setThinkingTooltipRect] = useState<{ top: number; bottom: number } | null>(null);
  const [approvalOverlayBottomPx, setApprovalOverlayBottomPx] = useState<number | null>(null);
  const [isAgentStatusExpanded, setIsAgentStatusExpanded] = useState(false);
  const lastApprovalPromptTsRef = useRef(0);
  const approvalPromptWindowRef = useRef<number[]>([]);
  const resolvedApprovalIdsRef = useRef<Set<string>>(new Set());
  const approvalEnqueueTimeoutsRef = useRef<Map<string, number>>(new Map());
  const approvalTimeoutsRef = useRef<Map<string, number>>(new Map());
  const approvalDecisionInFlightRef = useRef<Set<string>>(new Set());
  const approvalOverlayRef = useRef<HTMLDivElement>(null);

  // State to track if any LLM providers are configured
  const [hasConfiguredProviders, setHasConfiguredProviders] = useState<boolean>(false);
  // Check if any providers are configured when component mounts
  useEffect(() => {
    const checkProviders = async () => {
      const configManager = ConfigManager.getInstance();
      const providers = await configManager.getConfiguredProviders();
      setHasConfiguredProviders(providers.length > 0);
    };
    const loadFeatureFlags = async () => {
      const result = await chrome.storage.sync.get({
        [OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]: getDefaultOversightArchetype().id,
        ...getOversightStorageQueryDefaults(),
        ...getOversightParameterStorageQueryDefaults(),
      });
      setSelectedArchetypeId(
        typeof result[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY] === 'string'
          ? result[OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]
          : getDefaultOversightArchetype().id
      );
      setMechanismSettings(mapStorageToOversightSettings(result as Record<string, unknown>));
      setMechanismParameterSettings(mapStorageToOversightParameterSettings(result as Record<string, unknown>));
    };
    checkProviders();
    loadFeatureFlags();

    // Listen for provider configuration changes
    const handleMessage = (message: any) => {
      if (message.action === 'providerConfigChanged') {
        checkProviders();
        loadFeatureFlags();
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  // Use custom hooks to manage state and functionality
  const {
    tabId,
    windowId,
    setTabTitle
  } = useTabManagement();

  const {
    messages,
    streamingSegments,
    isStreaming,
    isProcessing,
    setIsProcessing,
    outputRef,
    addMessage,
    addUserMessage,
    addSystemMessage: addRawSystemMessage,
    updateStreamingChunk,
    finalizeStreamingSegment,
    startNewSegment,
    completeStreaming,
    clearMessages,
    currentSegmentId
  } = useMessageManagement();

  const stripToolCallMarkup = (text: string): string => {
    if (!text) return '';
    return stripToolMarkup(text).trim();
  };

  const getLatestThinking = (): string => {
    const currentStreaming = stripToolCallMarkup(streamingSegments[currentSegmentId] || '');
    if (currentStreaming) {
      return currentStreaming.slice(-400);
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== 'llm') continue;
      const cleaned = stripToolCallMarkup(messages[i].content || '');
      if (cleaned) return cleaned.slice(-400);
    }

    return '';
  };

  const {
    taskNodes,
    agentFocus,
    handleOversightEvent,
    logHumanTelemetry,
    resetRunState,
    clearOversightState,
  } = useOversightMechanisms({
    mechanismSettings,
    mechanismParameterSettings,
    getLatestThinking,
  });

  const enableAgentFocus = mechanismSettings[AGENT_FOCUS_MECHANISM_ID];
  const enableTaskGraph = mechanismSettings[TASK_GRAPH_MECHANISM_ID];
  const isRiskGatedArchetype = selectedArchetypeId === 'risk-gated';
  const isStructuralAmplificationArchetype = selectedArchetypeId === 'structural-amplification';
  const isActionConfirmationArchetype = selectedArchetypeId === 'action-confirmation';
  const isSupervisoryCoExecutionArchetype = selectedArchetypeId === 'supervisory-co-execution';
  const hasStartedCurrentTask = currentPrompt.trim().length > 0;
  const isAgentActivelyWorking =
    hasStartedCurrentTask &&
    runtimeStatus.executionState === 'running' &&
    (isProcessing || isStreaming || tabStatus === 'running');

  const toUserFacingStatus = useCallback((text: string): string => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const softened = normalized
      .replace(/^i(?:'m| am)\s+/i, '')
      .replace(/^i\s+(?:will|want to|need to|plan to)\s+/i, '')
      .replace(/^the agent\s+(?:will|wants to|needs to|is going to)\s+/i, '')
      .replace(/^next step i plan to do:\s*/i, '')
      .replace(/^why i choose a over b:\s*/i, '')
      .replace(/^alternative:\s*/i, '')
      .replace(/\bcurrent page\b/gi, 'the page')
      .replace(/\bpage state\b/gi, 'what is on the page')
      .replace(/\bfocus\b/gi, 'page area')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.;:,!?]+$/g, '');

    if (!softened) return '';

    const phrase = `${softened.charAt(0).toLowerCase()}${softened.slice(1)}`;
    const firstWord = phrase.split(/\s+/)[0] || '';
    const alreadyProgressive = /ing$/i.test(firstWord);
    const looksLikeState =
      /^(ready|idle|stuck|done|finished|paused|waiting|trying|about|unable|focused)\b/i.test(phrase);

    if (alreadyProgressive || looksLikeState) {
      return `Right now the agent is ${phrase}.`;
    }

    return `Right now the agent is working to ${phrase}.`;
  }, []);

  const summarizeLiveAgentStatus = useCallback((): string => {
    if (runtimeStatus.softPause?.active) {
      return `Right now the agent is waiting ${Math.max(0, Math.ceil((runtimeStatus.softPause.endsAt - softPauseNow) / 1000))}s before continuing, unless you step in.`;
    }

    const primary = (agentFocus.thinking || '').replace(/\s+/g, ' ').trim();
    if (primary) {
      return toUserFacingStatus(primary);
    }

    const focus = (agentFocus.focusLabel || '').replace(/\s+/g, ' ').trim();
    if (focus && focus !== 'Waiting for agent action') {
      return `Right now the agent is working with ${focus}.`;
    }

    const activeNode = [...taskNodes].reverse().find((node) => node.status === 'active');
    if (activeNode?.thinking?.trim()) {
      return toUserFacingStatus(activeNode.thinking);
    }
    if (activeNode?.focusLabel?.trim()) {
      return `Right now the agent is working with ${activeNode.focusLabel.replace(/\s+/g, ' ').trim()}.`;
    }

    return 'Right now the agent is still working on your request.';
  }, [agentFocus.focusLabel, agentFocus.thinking, runtimeStatus.softPause?.active, runtimeStatus.softPause?.endsAt, softPauseNow, taskNodes, toUserFacingStatus]);
  useEffect(() => {
    setIsAgentStatusExpanded(false);
  }, [agentFocus.focusLabel, agentFocus.thinking, runtimeStatus.softPause?.active, runtimeStatus.softPause?.endsAt, taskNodes]);
  const monitoringParams = mechanismParameterSettings[MONITORING_MECHANISM_ID] || {};
  const interventionParams = mechanismParameterSettings[INTERVENTION_GATE_MECHANISM_ID] || {};
  const taskGraphParams = mechanismParameterSettings[TASK_GRAPH_MECHANISM_ID] || {};
  const runtimePolicy = runtimeStatus.runtimePolicy;
  const storedMonitoringContentScope =
    monitoringParams.monitoringContentScope === 'minimal' ||
    monitoringParams.monitoringContentScope === 'standard' ||
    monitoringParams.monitoringContentScope === 'full'
      ? monitoringParams.monitoringContentScope
      : 'full';
  const storedExplanationAvailability =
    monitoringParams.explanationAvailability === 'none' ||
    monitoringParams.explanationAvailability === 'summary' ||
    monitoringParams.explanationAvailability === 'full'
      ? monitoringParams.explanationAvailability
      : 'summary';
  const monitoringContentScope =
    runtimePolicy?.monitoringContentScope ?? storedMonitoringContentScope;
  const explanationAvailability =
    runtimePolicy?.explanationAvailability ?? storedExplanationAvailability;
  const explanationFormat =
    monitoringParams.explanationFormat === 'text' ||
    monitoringParams.explanationFormat === 'snippet' ||
    monitoringParams.explanationFormat === 'diff'
      ? monitoringParams.explanationFormat
      : 'text';
  const notificationModality =
    monitoringParams.notificationModality === 'badge' ||
    monitoringParams.notificationModality === 'modal' ||
    monitoringParams.notificationModality === 'mixed'
      ? monitoringParams.notificationModality
      : 'mixed';
  const feedbackLatencyMs = Math.max(0, Number(monitoringParams.feedbackLatencyMs || 0));
  const persistenceMs = Math.max(0, Number(runtimePolicy?.persistenceMs ?? monitoringParams.persistenceMs ?? 0));
  const contentGranularity =
    taskGraphParams.contentGranularity === 'task' ||
    taskGraphParams.contentGranularity === 'step' ||
    taskGraphParams.contentGranularity === 'substep'
      ? taskGraphParams.contentGranularity
      : 'step';
  const informationDensity =
    taskGraphParams.informationDensity === 'compact' ||
    taskGraphParams.informationDensity === 'balanced' ||
    taskGraphParams.informationDensity === 'detailed'
      ? taskGraphParams.informationDensity
      : 'balanced';
  const colorEncoding =
    taskGraphParams.colorEncoding === 'semantic' ||
    taskGraphParams.colorEncoding === 'monochrome' ||
    taskGraphParams.colorEncoding === 'high_contrast'
      ? taskGraphParams.colorEncoding
      : 'semantic';
  useEffect(() => {
    setActivePanel(isStructuralAmplificationArchetype ? 'oversight' : 'conversation');
  }, [isStructuralAmplificationArchetype]);
  const interruptCooldownMs = Math.max(0, Number(interventionParams.interruptCooldownMs || 0));
  const interruptTopK = Math.max(1, Number(interventionParams.interruptTopK || 999));
  const approvedPlanSteps = approvedPlan?.steps || [];
  const shouldHideConversationSystemMessage = useCallback((text: string): boolean => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (/^[⚠️✅❌⏸️✏️🧭🔄🗺️ℹ️⌛📢🕹️]/u.test(normalized)) {
      return true;
    }
    return (
      normalized === '✏️ Updated the next plan step. The agent will use the revised step after approval.' ||
      normalized === '⏸️ Plan step rejected. Agent paused so you can take over.' ||
      normalized === '⏸️ Agent paused. You can take over the page now, then resume the agent when ready.'
    );
  }, []);
  const addSystemMessage = useCallback((text: string) => {
    if (shouldHideConversationSystemMessage(text)) {
      return;
    }
    addRawSystemMessage(text);
  }, [addRawSystemMessage, shouldHideConversationSystemMessage]);

  const buildPlanStepApprovalReason = useCallback((planStepNumber: number, planStepText: string) => {
    const normalizedStepText = planStepText.replace(/\s+/g, ' ').trim();
    return `Next up is step ${planStepNumber}: ${normalizedStepText} Approve to let the agent continue with this step. Reject to pause the agent so you can take over.`;
  }, []);

  const clearApprovalRequestState = useCallback((requestId: string) => {
    setApprovalRequests((prev) => prev.filter((req) => req.requestId !== requestId));
    setSupervisoryPlanStepOriginals((prev) => {
      if (!(requestId in prev)) return prev;
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
    setPlanStepUpdateRequestId((prev) => (prev === requestId ? null : prev));
  }, []);

  // Heartbeat interval for checking agent status
  useEffect(() => {
    if (!isProcessing) return;

    const interval = setInterval(() => {
      // Request agent status
      chrome.runtime.sendMessage({
        action: 'checkAgentStatus',
        tabId,
        windowId
      });
    }, 2000); // Check every 2 seconds

    return () => clearInterval(interval);
  }, [isProcessing, tabId, windowId]);

  // Handlers for approval requests
  const handleApprove = (requestId: string) => {
    approvalDecisionInFlightRef.current.add(requestId);
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(requestId);
    }
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const editedSupervisoryPlanStep =
      request?.approvalVariant === 'supervisory-plan-step' &&
      typeof supervisoryPlanStepOriginals[requestId] === 'string' &&
      supervisoryPlanStepOriginals[requestId].trim() !== (request.toolInput || '').trim();
    console.info('[approval-debug] UI approve button clicked', {
      requestId,
      approvalVariant: request?.approvalVariant,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      editedSupervisoryPlanStep,
    });
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_accepted',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('human_intervention', {
      action: 'override_performed',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });

    if (editedSupervisoryPlanStep) {
      void supersedeApprovalRequest(requestId)
        .then(() => {
          clearApprovalRequestState(requestId);
          setHaltReason(null);
          addSystemMessage('✏️ Revised plan step accepted. The stale proposal was discarded and execution will continue with the updated step.');
        })
        .catch((error) => {
          addSystemMessage(`❌ Failed to continue after revising the plan step: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          approvalDecisionInFlightRef.current.delete(requestId);
        });
      return;
    }

    void approveRequest(requestId, 'once')
      .then(() => {
        clearApprovalRequestState(requestId);
        setHaltReason(null);
      })
      .catch((error) => {
        addSystemMessage(`❌ Failed to send approval: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        approvalDecisionInFlightRef.current.delete(requestId);
      });
  };

  const handleApproveSeries = (requestId: string) => {
    approvalDecisionInFlightRef.current.add(requestId);
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(requestId);
    }
    const request = approvalRequests.find((req) => req.requestId === requestId);
    console.info('[approval-debug] UI approve-similar button clicked', {
      requestId,
      approvalVariant: request?.approvalVariant,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_accepted',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
      mode: 'series',
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
      mode: 'series',
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });

    void approveRequest(requestId, 'series')
      .then(() => {
        clearApprovalRequestState(requestId);
        setHaltReason(null);
      })
      .catch((error) => {
        addSystemMessage(`❌ Failed to send approval: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        approvalDecisionInFlightRef.current.delete(requestId);
      });
  };

  const handleApproveSite = (requestId: string) => {
    approvalDecisionInFlightRef.current.add(requestId);
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(requestId);
    }
    const request = approvalRequests.find((req) => req.requestId === requestId);
    console.info('[approval-debug] UI approve-site button clicked', {
      requestId,
      approvalVariant: request?.approvalVariant,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_accepted',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
      mode: 'site',
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
      mode: 'site',
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });
    void approveRequest(requestId, 'site')
      .then(() => {
        clearApprovalRequestState(requestId);
        setHaltReason(null);
      })
      .catch((error) => {
        addSystemMessage(`❌ Failed to send approval: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        approvalDecisionInFlightRef.current.delete(requestId);
      });
  };

  const handleReject = (requestId: string) => {
    approvalDecisionInFlightRef.current.add(requestId);
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(requestId);
    }
    const request = approvalRequests.find((req) => req.requestId === requestId);
    console.info('[approval-debug] UI reject button clicked', {
      requestId,
      approvalVariant: request?.approvalVariant,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_rejected',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });
    void logHumanTelemetry('state_transition', {
      kind: 'step_outcome',
      stepId,
      executed: false,
      blockedByUser: true,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });

    void rejectRequest(requestId)
      .then(() => {
        clearApprovalRequestState(requestId);
      })
      .catch((error) => {
        // addSystemMessage(`❌ Failed to send rejection: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        approvalDecisionInFlightRef.current.delete(requestId);
      });
  };

  const sendApprovalDecision = useCallback((requestId: string, approved: boolean, approvalMode: 'once' | 'series' | 'site' = 'once') => {
    chrome.runtime.sendMessage({
      action: 'approvalResponse',
      requestId,
      approved,
      approvalMode,
      tabId: tabId || undefined,
      windowId: windowId || undefined,
    });
  }, [tabId, windowId]);

  const supersedeApprovalRequest = useCallback((requestId: string) => {
    return new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'approvalResponse',
        requestId,
        approved: false,
        resolution: 'supersede',
        tabId,
        windowId,
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || 'Supersede response was not accepted by background'));
          return;
        }
        resolve();
      });
    });
  }, [tabId, windowId]);

  const handleDismissWarning = (requestId: string) => {
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(requestId);
    }
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_monitoring', {
      action: 'warning_dismissed',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });
    void logHumanTelemetry('state_transition', {
      kind: 'step_outcome',
      stepId,
      executed: false,
      blockedByUser: true,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });

    // Dismissing a pending approval also rejects it to avoid blocking execution.
    sendApprovalDecision(requestId, false);
    clearApprovalRequestState(requestId);
    addSystemMessage('⏸️ Agent paused. You can inspect or edit the page, then resume when ready.');
  };

  const handleApprovalResolved = useCallback((payload: { requestId: string; approved: boolean }) => {
    resolvedApprovalIdsRef.current.add(payload.requestId);
    approvalDecisionInFlightRef.current.delete(payload.requestId);
    const enqueueTimeout = approvalEnqueueTimeoutsRef.current.get(payload.requestId);
    if (typeof enqueueTimeout === 'number') {
      window.clearTimeout(enqueueTimeout);
      approvalEnqueueTimeoutsRef.current.delete(payload.requestId);
    }
    const pendingTimeout = approvalTimeoutsRef.current.get(payload.requestId);
    if (typeof pendingTimeout === 'number') {
      window.clearTimeout(pendingTimeout);
      approvalTimeoutsRef.current.delete(payload.requestId);
    }

    setApprovalRequests((prev) => {
      const request = prev.find((item) => item.requestId === payload.requestId);
      if (request) {
        const stepId = request.stepId || payload.requestId;
        void logHumanTelemetry('oversight_signal', {
          kind: 'intervention_decision',
          stepId,
          decision: payload.approved ? 'approve' : 'deny',
        });
        handleOversightEvent({
          kind: 'intervention_decision',
          stepId,
          decision: payload.approved ? 'approve' : 'deny',
        });
      }
      return prev.filter((item) => item.requestId !== payload.requestId);
    });
    setSupervisoryPlanStepOriginals((prev) => {
      if (!(payload.requestId in prev)) return prev;
      const next = { ...prev };
      delete next[payload.requestId];
      return next;
    });
    setPlanStepUpdateRequestId((prev) => (prev === payload.requestId ? null : prev));
  }, [handleOversightEvent, logHumanTelemetry]);

  // Set up Chrome messaging with callbacks
  const {
    executePrompt,
    cancelExecution,
    clearHistory,
    approveRequest,
    rejectRequest,
    pauseExecution,
    resumeExecution,
    submitSoftPauseDecision,
    submitPlanReviewDecision,
    updateApprovedPlan,
    runtimeInteractionSignal,
    assessPlanProgress,
  } = useChromeMessaging({
    tabId,
    windowId,
    onUpdateOutput: (content) => {
      if (typeof content?.content === 'string' && shouldHideConversationSystemMessage(content.content)) {
        return;
      }
      if (content?.type === 'system' &&
          typeof content.content === 'string' &&
          content.content.startsWith('🕹️ tool:')) {
        return;
      }
      if (
        content?.type === 'system' &&
        typeof content.content === 'string' &&
        content.content.startsWith('Executing prompt: ')
      ) {
        return;
      }
      if (
        typeof content?.content === 'string' &&
        (
          content.content.startsWith('⚠️ This action requires approval:') ||
          content.content.startsWith('✅ Action approved by user. Executing...')
        )
      ) {
        return;
      }
      if (
        typeof content?.content === 'string' &&
        (
          content.content.includes('Requesting a corrected XML tool call.') ||
          content.content.includes('Requesting a corrected action proposal before approval.')
        )
      ) {
        return;
      }
      if (typeof content?.content === 'string' && content.content.includes('Execution stopped by post-action review policy')) {
        setHaltReason('Stopped by post-action review policy');
      }
      addMessage({ ...content, isComplete: true });
    },
    onUpdateStreamingChunk: (content) => {
      updateStreamingChunk(content.content);
    },
    onFinalizeStreamingSegment: (id, content) => {
      finalizeStreamingSegment(id, content);
    },
    onStartNewSegment: (id) => {
      startNewSegment(id);
    },
    onStreamingComplete: () => {
      completeStreaming();
    },
    onUpdateLlmOutput: (content) => {
      addMessage({ type: 'llm', content, isComplete: true });
    },
    onRateLimit: () => {
      addSystemMessage("⚠️ Rate limit reached. Retrying automatically...");
      // Ensure the UI stays in processing mode
      setIsProcessing(true);
      // Update the tab status to running
      setTabStatus('running');
    },
    onFallbackStarted: (message) => {
      addSystemMessage(message);
      // Ensure the UI stays in processing mode
      setIsProcessing(true);
      // Update the tab status to running
      setTabStatus('running');
    },
    onUpdateScreenshot: (content) => {
      addMessage({ ...content, isComplete: true });
    },
    onProcessingComplete: () => {
      setIsProcessing(false);
      completeStreaming();
      // Also update the tab status to idle to ensure the UI indicator changes
      setTabStatus('idle');
    },
    onRequestApproval: (request) => {
      const now = Date.now();
      const isSupervisoryPrompt =
        request.approvalVariant === 'supervisory' || request.approvalVariant === 'supervisory-plan-step';
      approvalPromptWindowRef.current = approvalPromptWindowRef.current.filter((ts) => now - ts < 60000);

      if (!isSupervisoryPrompt && approvalPromptWindowRef.current.length >= interruptTopK) {
        sendApprovalDecision(request.requestId, true);
        addSystemMessage(`ℹ️ Auto-approved ${request.requestId} due to interruptTopK.`);
        return;
      }

      if (!isSupervisoryPrompt && interruptCooldownMs > 0 && now - lastApprovalPromptTsRef.current < interruptCooldownMs) {
        sendApprovalDecision(request.requestId, true);
        addSystemMessage(`ℹ️ Auto-approved ${request.requestId} due to interrupt cooldown.`);
        return;
      }

      const enqueueTimeoutId = window.setTimeout(() => {
        approvalEnqueueTimeoutsRef.current.delete(request.requestId);
        if (resolvedApprovalIdsRef.current.has(request.requestId)) {
          return;
        }
        if (approvalDecisionInFlightRef.current.has(request.requestId)) {
          return;
        }
        if (request.approvalVariant === 'supervisory-plan-step') {
          setSupervisoryPlanStepOriginals((prev) =>
            request.requestId in prev ? prev : { ...prev, [request.requestId]: request.toolInput }
          );
        }
        setApprovalRequests(prev => [...prev, request]);
        const timestamp = Date.now();
        lastApprovalPromptTsRef.current = timestamp;
        approvalPromptWindowRef.current.push(timestamp);

        if (notificationModality !== 'badge') {
          setShowApprovalOverlay(true);
        }

        if (persistenceMs > 0 && !isStructuralAmplificationArchetype && !isSupervisoryPrompt) {
          const timeoutId = window.setTimeout(() => {
            setApprovalRequests((prev) => {
              if (approvalDecisionInFlightRef.current.has(request.requestId)) {
                return prev;
              }
              const exists = prev.some((item) => item.requestId === request.requestId);
              if (!exists) return prev;
              approvalTimeoutsRef.current.delete(request.requestId);
              sendApprovalDecision(request.requestId, false);
              addSystemMessage(`⌛ Auto-rejected expired approval: ${request.requestId}`);
              return prev.filter((item) => item.requestId !== request.requestId);
            });
          }, persistenceMs);
          approvalTimeoutsRef.current.set(request.requestId, timeoutId);
        }
      }, feedbackLatencyMs);
      approvalEnqueueTimeoutsRef.current.set(request.requestId, enqueueTimeoutId);
    },
    onApprovalResolved: handleApprovalResolved,
    setTabTitle,
    // New event handlers for tab events
    onTabStatusChanged: (status, _tabId) => {
      // Update the tab status state
      setTabStatus(status);
    },
    onTargetChanged: (_tabId, _url) => {
      // We don't need to do anything here as TabStatusBar handles this
    },
    onActiveTabChanged: (oldTabId, newTabId, title, url) => {
      // Update the tab title when the agent switches tabs
      console.log(`SidePanel: Active tab changed from ${oldTabId} to ${newTabId}`);
      setTabTitle(title);

      // Add a system message to indicate the tab change
      addSystemMessage(`Switched to tab: ${title} (${url})`);
    },
    onPageDialog: (_tabId, dialogInfo) => {
      // Add a system message about the dialog
      addSystemMessage(`📢 Dialog: ${dialogInfo.type} - ${dialogInfo.message}`);
    },
    onPageError: (_tabId, error) => {
      // Add a system message about the error
      addSystemMessage(`❌ Page Error: ${error}`);
    },
    onAgentStatusUpdate: (status, lastHeartbeat) => {
      // Log agent status updates for debugging
      console.log(`Agent status update: ${status}, lastHeartbeat: ${lastHeartbeat}, diff: ${Date.now() - lastHeartbeat}ms`);

      // Update the tab status based on agent status
      if (status === 'running' || status === 'idle' || status === 'error') {
        setTabStatus(status);
      }

      // If agent is running, ensure UI is in processing mode
      if (status === 'running') {
        setIsProcessing(true);
      }

      // If agent is idle, ensure UI is not in processing mode
      if (status === 'idle') {
        setIsProcessing(false);
      }

      if (status === 'error') {
        handleOversightEvent({
          kind: 'run_failed',
          timestamp: Date.now(),
          focusLabel: 'Execution failed',
          error: 'Agent status error',
        });
      }
    },
    onOversightEvent: (event) => {
      if (event.kind === 'intent_refresh_triggered') {
        addSystemMessage('Still aiming to current goal? (auto-confirming Yes...)');
      }
      if (event.kind === 'intent_refresh_confirmed') {
        addSystemMessage('Intent refresh confirmed: Yes.');
      }
      if (isSupervisoryCoExecutionArchetype && event.kind === 'tool_started') {
        setSupervisoryActualSteps((prev) => [
          ...prev,
          {
            stepId: event.stepId,
            toolName: event.toolName,
            focusLabel: event.focusLabel,
            stepDescription: event.stepDescription,
            thinking: event.stepDescription,
            planStepIndex: event.planStepIndex,
            timestamp: event.timestamp,
          },
        ]);
      }
      if (isSupervisoryCoExecutionArchetype && event.kind === 'agent_thinking') {
        setSupervisoryActualSteps((prev) =>
          prev.map((step) =>
            step.stepId === event.stepId
              ? {
                  ...step,
                  thinking: event.thinking.rationale || event.thinking.goal,
                }
              : step
          )
        );
      }
      if (isStructuralAmplificationArchetype && event.kind === 'agent_thinking') {
        console.log('[structural-debug] agent_thinking', {
          stepId: event.stepId,
          toolName: event.toolName,
          thinking: event.thinking.rationale || event.thinking.goal || '',
        });
      }
      handleOversightEvent(event);
    },
    onRuntimeStateUpdate: (status) => {
      console.log('[structural-debug] runtimeStateUpdate', {
        selectedArchetypeId,
        phase: status.executionPhase,
        state: status.executionState,
        regime: status.regime,
        amplification: status.amplification?.state,
        softPauseActive: status.softPause?.active,
      });
      setRuntimeStatus(status);
      if (
        status.executionState === 'paused_by_user' ||
        status.executionState === 'paused_by_system' ||
        status.executionState === 'paused_by_system_soft'
      ) {
        setIsProcessing(true);
      }
      if (status.executionState === 'cancelled' || status.executionState === 'completed') {
        setIsProcessing(false);
      }
    },
    onPlanReviewRequired: isActionConfirmationArchetype ? undefined : (payload) => {
      console.log('[structural-debug] planReviewRequired', {
        selectedArchetypeId,
        stepCount: payload.plan?.length ?? 0,
        toolName: payload.toolName,
      });
      setPlanReviewRequest(payload);
      setEditedPlanSteps((payload.plan || []).filter((step) => step.trim().length > 0));
      setEditingPlanStepIndex(null);
      if (isStructuralAmplificationArchetype) {
        setActivePanel('oversight');
      }
      addSystemMessage('🧭 Plan review required before execution.');
    },
  });

  const updateSupervisoryPlanStep = useCallback(async (requestId: string, nextStepText: string) => {
    const request = approvalRequests.find((item) => item.requestId === requestId);
    if (!request || request.approvalVariant !== 'supervisory-plan-step' || typeof request.planStepIndex !== 'number') {
      addSystemMessage('⚠️ This approval request no longer has an editable plan step.');
      return;
    }
    if (!approvedPlan) {
      addSystemMessage('⚠️ No approved plan is available to update.');
      return;
    }

    const normalizedStepText = nextStepText.trim();
    if (!normalizedStepText) {
      addSystemMessage('⚠️ Plan steps cannot be empty.');
      return;
    }

    if (request.planStepIndex < 0 || request.planStepIndex >= approvedPlan.steps.length) {
      addSystemMessage('⚠️ That plan step is out of range for the current approved plan.');
      return;
    }

    const planStepIndex = request.planStepIndex;
    const currentStepText = approvedPlan.steps[request.planStepIndex]?.trim() || '';
    if (currentStepText === normalizedStepText) {
      return;
    }

    const updatedSteps = approvedPlan.steps.map((step, index) =>
      index === planStepIndex ? normalizedStepText : step
    );
    const editedPlan = [
      `Plan Summary: ${approvedPlan.summary}`,
      ...updatedSteps.map((step, index) => `Step ${index + 1}: ${step}`),
    ].join('\n');
    const activePlanStepIndex = Math.max(
      0,
      inspectPlanProgress?.currentStepNumber && inspectPlanProgress.currentStepNumber > 0
        ? inspectPlanProgress.currentStepNumber - 1
        : inspectPlanProgress?.completedCount || 0
    );

    setPlanStepUpdateRequestId(requestId);
    try {
      const response = await updateApprovedPlan(editedPlan, {
        editedStepIndex: request.planStepIndex,
        regenerateRemainingStepsAfterExecution: request.planStepIndex === activePlanStepIndex,
      });
      if (!response?.success) {
        addSystemMessage(`⚠️ Failed to update the next plan step: ${response?.error || 'unknown error'}`);
        return;
      }

      runtimeInteractionSignal('edit_intermediate_output');
      setApprovedPlan({
        summary: approvedPlan.summary,
        steps: updatedSteps,
      });
      setApprovalRequests((prev) =>
        prev.map((item) =>
          item.requestId === requestId
            ? {
                ...item,
                toolInput: normalizedStepText,
                reason: buildPlanStepApprovalReason(planStepIndex + 1, normalizedStepText),
              }
            : item
        )
      );
      
    } catch (error) {
      addSystemMessage(`⚠️ Failed to update the next plan step: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPlanStepUpdateRequestId((prev) => (prev === requestId ? null : prev));
    }
  }, [addSystemMessage, approvalRequests, approvedPlan, buildPlanStepApprovalReason, runtimeInteractionSignal, updateApprovedPlan]);

  const resetSupervisoryPlanStep = useCallback(async (requestId: string) => {
    const originalText = supervisoryPlanStepOriginals[requestId];
    if (!originalText) return;
    await updateSupervisoryPlanStep(requestId, originalText);
  }, [supervisoryPlanStepOriginals, updateSupervisoryPlanStep]);

  useEffect(() => {
    if (runtimeStatus.regime === 'deliberative_escalated') {
      if (isStructuralAmplificationArchetype) {
        setActivePanel('oversight');
      }
    }
  }, [runtimeStatus.regime, isStructuralAmplificationArchetype]);

  useEffect(() => {
    if (!runtimeStatus.softPause?.active) return;
    const timer = window.setInterval(() => {
      setSoftPauseNow(Date.now());
    }, 200);
    return () => window.clearInterval(timer);
  }, [runtimeStatus.softPause?.active]);

  useEffect(() => {
    if (!editingRemainingPlan) return;
    setRemainingPlanDraftSteps(remainingPlanTail);
    setEditingRemainingStepIndex(null);
  }, [
    editingRemainingPlan,
    approvedPlan?.steps,
    inspectPlanProgress?.currentStepNumber,
    inspectPlanProgress?.completedCount,
    approvedPlanSteps,
  ]);

  useEffect(() => {
    if (
      runtimeStatus.executionState !== 'paused_by_user' &&
      runtimeStatus.executionState !== 'paused_by_system_soft'
    ) {
      setShowInspectPlanModal(false);
    }
  }, [runtimeStatus.executionState]);

  useEffect(() => {
    if (!approvedPlan || approvedPlan.steps.length === 0) return;
    let cancelled = false;
    setInspectPlanLoading(true);
    setInspectPlanError(null);

    void assessPlanProgress({
      planSteps: approvedPlan.steps,
      agentSteps: taskNodes.map((node, index) => ({
        index: index + 1,
        status: node.status,
        toolName: node.toolName,
        focusLabel: node.focusLabel,
        thinking: node.thinking,
      })),
    })
      .then((assessment) => {
        if (cancelled) return;
        setInspectPlanProgress(assessment);
      })
      .catch((error) => {
        if (cancelled) return;
        setInspectPlanError(error instanceof Error ? error.message : String(error));
        setInspectPlanProgress({
          completedCount: 0,
          currentStepNumber: 0,
          isFullyCompleted: false,
          steps: approvedPlan.steps.map(() => ({
            status: 'pending',
            reason: 'LLM progress assessment unavailable.',
          })),
        });
      })
      .finally(() => {
        if (!cancelled) setInspectPlanLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [approvedPlan, taskNodes]);

  const handlePlanReviewApprove = () => {
    const steps = editedPlanSteps.map((step) => step.trim()).filter(Boolean);
    const originalSteps = (planReviewRequest?.plan || []).map((step) => step.trim()).filter(Boolean);
    console.log('[structural-debug] approving plan review', {
      selectedArchetypeId,
      stepCount: steps.length,
      reorderedOrEdited:
        steps.length !== originalSteps.length || steps.some((step, index) => step !== originalSteps[index]),
      tabId,
      windowId,
    });
    if (steps.length > 0) {
      setApprovedPlan({
        summary: planReviewRequest?.planSummary || 'Approved plan.',
        steps,
      });
      setInspectPlanProgress(null);
      setInspectPlanError(null);
    }
    const reorderedOrEdited =
      steps.length !== originalSteps.length || steps.some((step, index) => step !== originalSteps[index]);
    if (reorderedOrEdited) {
      const editedPlan = steps.map((step, idx) => `${idx + 1}. ${step}`).join('\n');
      submitPlanReviewDecision('edit', editedPlan);
      addSystemMessage('✅ Plan order updated and approved.');
    } else {
      submitPlanReviewDecision('approve');
      addSystemMessage('✅ Plan approved. Execution continues.');
    }
    setPlanReviewRequest(null);
    setEditedPlanSteps([]);
    setEditingPlanStepIndex(null);
  };

  const handlePlanStepChange = (index: number, value: string) => {
    setEditedPlanSteps((prev) => prev.map((step, idx) => (idx === index ? value : step)));
  };

  const handlePlanStepAdd = () => {
    setEditedPlanSteps((prev) => {
      const next = [...prev, ''];
      setEditingPlanStepIndex(next.length - 1);
      return next;
    });
  };

  const handlePlanStepRemove = (index: number) => {
    setEditedPlanSteps((prev) => prev.filter((_, idx) => idx !== index));
    setEditingPlanStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === index) return null;
      return prev > index ? prev - 1 : prev;
    });
  };

  const movePlanStep = (fromIndex: number, toIndex: number) => {
    setEditedPlanSteps((prev) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
    setEditingPlanStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === fromIndex) return toIndex;
      if (fromIndex < toIndex && prev > fromIndex && prev <= toIndex) return prev - 1;
      if (toIndex < fromIndex && prev >= toIndex && prev < fromIndex) return prev + 1;
      return prev;
    });
  };

  const moveRemainingPlanStep = (fromIndex: number, toIndex: number) => {
    setRemainingPlanDraftSteps((prev) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
    setEditingRemainingStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === fromIndex) return toIndex;
      if (fromIndex < toIndex && prev > fromIndex && prev <= toIndex) return prev - 1;
      if (toIndex < fromIndex && prev >= toIndex && prev < fromIndex) return prev + 1;
      return prev;
    });
  };

  const clearConversationState = useCallback(() => {
    approvalEnqueueTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    approvalEnqueueTimeoutsRef.current.clear();
    approvalTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    approvalTimeoutsRef.current.clear();
    approvalDecisionInFlightRef.current.clear();
    clearMessages();
    clearHistory();
    clearOversightState();
    setSupervisoryActualSteps([]);
    setCurrentPrompt('');
    setHaltReason(null);
    setApprovedPlan(null);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    setApprovalRequests([]);
    setSupervisoryPlanStepOriginals({});
    setPlanStepUpdateRequestId(null);
  }, [clearHistory, clearMessages, clearOversightState]);

  const handleApplyArchetype = useCallback((archetypeId: string) => {
    const archetype = getOversightArchetypeById(archetypeId);
    if (!archetype || archetype.id === selectedArchetypeId) {
      return;
    }

    const nextState = cloneArchetypeState(archetype);
    clearConversationState();
    setSelectedArchetypeId(archetype.id);
    setMechanismSettings(nextState.settings);
    setMechanismParameterSettings(nextState.parameterSettings);
    setIsApplyingArchetype(true);

    chrome.storage.sync.set(
      {
        [OVERSIGHT_SELECTED_ARCHETYPE_STORAGE_KEY]: archetype.id,
        ...buildOversightStoragePatch(nextState.settings),
        ...buildOversightParameterStoragePatch(nextState.parameterSettings),
      },
      () => {
        setIsApplyingArchetype(false);
        chrome.runtime.sendMessage({
          action: 'providerConfigChanged'
        }).catch(err => console.error('Error sending message:', err));
      }
    );
  }, [clearConversationState, selectedArchetypeId]);

  const handleRemainingPlanStepChange = (index: number, value: string) => {
    setRemainingPlanDraftSteps((prev) => prev.map((step, idx) => (idx === index ? value : step)));
  };

  const handleRemainingPlanStepAdd = () => {
    setRemainingPlanDraftSteps((prev) => {
      const next = [...prev, ''];
      setEditingRemainingStepIndex(next.length - 1);
      return next;
    });
  };

  const handleRemainingPlanStepRemove = (index: number) => {
    setRemainingPlanDraftSteps((prev) => prev.filter((_, idx) => idx !== index));
    setEditingRemainingStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === index) return null;
      return prev > index ? prev - 1 : prev;
    });
  };

  const handleRemainingPlanSubmit = async () => {
    if (!approvedPlan) return;
    const normalizedTail = remainingPlanDraftSteps.map((step) => step.trim()).filter(Boolean);
    const mergedSteps = [...remainingPlanPrefix, ...normalizedTail];
    if (mergedSteps.length === 0) {
      addSystemMessage('⚠️ Please keep at least one remaining plan step.');
      return;
    }
    const editedPlan = [
      `Plan Summary: ${approvedPlan.summary}`,
      ...mergedSteps.map((step, idx) => `Step ${idx + 1}: ${step}`),
    ].join('\n');
    const response = await updateApprovedPlan(editedPlan);
    if (!response?.success) {
      addSystemMessage(`⚠️ Failed to update the remaining plan: ${response?.error || 'unknown error'}`);
      return;
    }
    runtimeInteractionSignal('edit_intermediate_output');
    setApprovedPlan({
      summary: approvedPlan.summary,
      steps: mergedSteps,
    });
    setEditingRemainingPlan(false);
    setEditingRemainingStepIndex(null);
    addSystemMessage('✏️ Updated the remaining plan steps. The agent will follow the revised order after resume.');
  };

  const handlePlanReviewReject = () => {
    submitPlanReviewDecision('reject');
    setApprovedPlan(null);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    setPlanReviewRequest(null);
    setEditedPlanSteps([]);
    setEditingPlanStepIndex(null);
    setIsProcessing(false);
    addSystemMessage('❌ Plan rejected. Execution terminated.');
  };

  // Handle form submission
  const handleSubmit = async (prompt: string) => {
    setIsProcessing(true);
    setCurrentPrompt(prompt);
    setHaltReason(null);
    setSupervisoryActualSteps([]);
    setApprovedPlan(null);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    // Update the tab status to running
    setTabStatus('running');
    resetRunState();

    addUserMessage(prompt);
    setActivePanel(isStructuralAmplificationArchetype ? 'oversight' : 'conversation');

    try {
      await executePrompt(prompt);
    } catch (error) {
      console.error('Error:', error);
      addSystemMessage('Error: ' + (error instanceof Error ? error.message : String(error)));
      setIsProcessing(false);
      // Update the tab status to error
      setTabStatus('error');
      handleOversightEvent({
        kind: 'run_failed',
        timestamp: Date.now(),
        focusLabel: 'Execution failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Handle cancellation - also reject any pending approval requests
  const handleCancel = () => {
    // If there are any pending approval requests, reject them all
    if (approvalRequests.length > 0) {
      // Add a system message to indicate that approvals were rejected due to cancellation
      addSystemMessage(`❌ Cancelled execution - all pending approval requests were automatically rejected`);

      // Reject each pending approval request
      approvalRequests.forEach(req => {
        rejectRequest(req.requestId);
      });

      // Clear the approval requests
      setApprovalRequests([]);
      setSupervisoryPlanStepOriginals({});
      setPlanStepUpdateRequestId(null);
    }

    // Cancel the execution
    cancelExecution();

    // Update the tab status to idle
    setTabStatus('idle');
    handleOversightEvent({
      kind: 'run_cancelled',
      timestamp: Date.now(),
      focusLabel: 'Execution cancelled',
    });
  };

  // Handle clearing history
  const handleClearHistory = () => {
    clearConversationState();
  };


  // Function to navigate to the options page
  const navigateToOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const pendingApprovalCount = approvalRequests.length;
  const shouldShowBadge =
    !isStructuralAmplificationArchetype &&
    pendingApprovalCount > 0 &&
    (notificationModality === 'badge' || notificationModality === 'mixed');
  const shouldShowOverlay =
    !isStructuralAmplificationArchetype &&
    pendingApprovalCount > 0 &&
    (notificationModality === 'modal' || notificationModality === 'mixed' || showApprovalOverlay);
  const hasSupervisoryPlanStepApproval = approvalRequests.some(
    (request) => request.approvalVariant === 'supervisory-plan-step'
  );
  const canPause = runtimeStatus.executionState === 'running';
  const canResume =
    runtimeStatus.executionState === 'paused_by_user' ||
    runtimeStatus.executionState === 'paused_by_system' ||
    runtimeStatus.executionState === 'paused_by_system_soft';
  const inspectPlanView = inspectPlanProgress ?? {
    completedCount: 0,
    currentStepNumber: 0,
    isFullyCompleted: false,
    steps: approvedPlanSteps.map(() => ({ status: 'pending' as const, reason: 'Awaiting LLM assessment.' })),
  };
  const currentPlanStepIndex = Math.max(0, inspectPlanView.currentStepNumber > 0 ? inspectPlanView.currentStepNumber - 1 : inspectPlanView.completedCount);
  const remainingPlanPrefix = approvedPlanSteps.slice(0, currentPlanStepIndex);
  const remainingPlanTail = approvedPlanSteps.slice(currentPlanStepIndex);
  const supervisoryPlanIndices = useMemo(
    () => supervisoryActualSteps.map((step) => (typeof step.planStepIndex === 'number' ? step.planStepIndex : null)),
    [supervisoryActualSteps]
  );
  const supervisoryVisibleUntilIndex = useMemo(() => {
    const maxActualStepIndex = supervisoryActualSteps.reduce(
      (max, step) => (typeof step.planStepIndex === 'number' ? Math.max(max, step.planStepIndex) : max),
      -1
    );
    const maxPendingApprovalIndex = approvalRequests.reduce(
      (max, request) =>
        request.approvalVariant === 'supervisory-plan-step' && typeof request.planStepIndex === 'number'
          ? Math.max(max, request.planStepIndex)
          : max,
      -1
    );
    return Math.max(0, maxActualStepIndex, maxPendingApprovalIndex);
  }, [approvalRequests, supervisoryActualSteps]);
  const supervisoryConversationMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (
          message.type === 'system' &&
          /^(🧭 Plan review required before execution\.|✅ Plan order updated and approved\.|✅ Plan approved\. Execution continues\.|✏️ Plan edited by user\. Applying guidance:)/.test(
            message.content || ''
          )
        ) {
          return false;
        }
        if (
          message.type === 'user' &&
          /^(Plan approved\. Follow this plan throughout the task|Follow this approved plan guidance for the full task)/.test(
            message.content || ''
          )
        ) {
          return false;
        }
        if (message.type !== 'llm') return true;
        return !/<thinking(?:_summary|\s+summary)>|<tool>|<requires_approval>/i.test(message.content || '');
      }),
    [messages]
  );
  const riskGatedConversationMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (message.type === 'user') return true;
        if (message.type === 'screenshot') return true;
        if (message.type === 'llm' && typeof message.content === 'string') {
          return message.content.trim().length > 0;
        }
        return false;
      }),
    [messages]
  );
  const supervisoryLeadingMessages = useMemo(() => {
    if (!isSupervisoryCoExecutionArchetype) return messages;
    const firstUserIndex = supervisoryConversationMessages.findIndex((message) => message.type === 'user');
    if (firstUserIndex < 0) return [];
    return supervisoryConversationMessages.slice(0, firstUserIndex + 1);
  }, [isSupervisoryCoExecutionArchetype, messages, supervisoryConversationMessages]);
  const supervisoryTrailingMessages = useMemo(() => {
    if (!isSupervisoryCoExecutionArchetype) return messages;
    const firstUserIndex = supervisoryConversationMessages.findIndex((message) => message.type === 'user');
    if (firstUserIndex < 0) return supervisoryConversationMessages;
    return supervisoryConversationMessages.slice(firstUserIndex + 1);
  }, [isSupervisoryCoExecutionArchetype, messages, supervisoryConversationMessages]);
  const supervisoryStreamingSegments = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(streamingSegments).filter(([, content]) => !/<thinking(?:_summary|\s+summary)>|<tool>|<requires_approval>/i.test(content))
      ),
    [streamingSegments]
  );
  const riskGatedStreamingSegments = useMemo(
    () => streamingSegments,
    [streamingSegments]
  );

  useEffect(() => {
    if (!isStructuralAmplificationArchetype || activePanel !== 'oversight' || !shouldShowOverlay) {
      setApprovalOverlayBottomPx(null);
      return;
    }

    const recalcOverlayPosition = () => {
      const overlayElement = approvalOverlayRef.current;
      if (!overlayElement || !thinkingTooltipRect) {
        setApprovalOverlayBottomPx(null);
        return;
      }

      const overlayHeight = overlayElement.getBoundingClientRect().height;
      const defaultBottomPx = 96;
      const minViewportPaddingPx = 16;
      const gapPx = 12;
      const defaultTop = window.innerHeight - defaultBottomPx - overlayHeight;
      const wouldClipBelowViewport = overlayHeight + defaultBottomPx > window.innerHeight - minViewportPaddingPx;
      const wouldOverlapThinking = defaultTop < thinkingTooltipRect.bottom + gapPx;

      if (!wouldClipBelowViewport && !wouldOverlapThinking) {
        setApprovalOverlayBottomPx(null);
        return;
      }

      const desiredBottomPx = window.innerHeight - thinkingTooltipRect.top + gapPx;
      const maxBottomPx = Math.max(defaultBottomPx, window.innerHeight - overlayHeight - minViewportPaddingPx);
      const nextBottomPx = Math.min(Math.max(defaultBottomPx, desiredBottomPx), maxBottomPx);
      setApprovalOverlayBottomPx(nextBottomPx > defaultBottomPx ? nextBottomPx : null);
    };

    const frameId = window.requestAnimationFrame(recalcOverlayPosition);
    window.addEventListener('resize', recalcOverlayPosition);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', recalcOverlayPosition);
    };
  }, [activePanel, approvalRequests.length, isStructuralAmplificationArchetype, shouldShowOverlay, thinkingTooltipRect]);

  return (
    <div className="morph-shell flex h-screen flex-col overflow-x-hidden bg-base-200/60">
      {hasConfiguredProviders ? (
        <>
          <div className="morph-surface flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-hidden bg-base-100">
            <div className="border-b border-base-300 px-3 py-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-base-content/50">
                      Oversight Regime
                    </label>
                    {isAgentActivelyWorking ? (
                      <span
                        className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-primary/25 border-t-primary"
                        aria-label="Agent is working"
                        title="Agent is working"
                      />
                    ) : null}
                  </div>
                </div>
                <OutputHeader
                  onOpenOptions={navigateToOptions}
                  onClearHistory={handleClearHistory}
                  isProcessing={isProcessing}
                />
              </div>
              <div className="flex items-start gap-3">
                <select
                  className="select select-bordered select-sm w-full"
                  value={selectedArchetypeId}
                  onChange={(e) => handleApplyArchetype(e.target.value)}
                  disabled={isApplyingArchetype}
                >
                  {BUILTIN_OVERSIGHT_ARCHETYPES.map((archetype) => (
                    <option key={archetype.id} value={archetype.id}>
                      {archetype.name}
                    </option>
                  ))}
                </select>
              </div>
              {isAgentActivelyWorking ? (
                <button
                  type="button"
                  className="mt-1 block w-full text-left text-sm text-base-content/60"
                  onClick={() => setIsAgentStatusExpanded((prev) => !prev)}
                  title={isAgentStatusExpanded ? 'Collapse status' : 'Expand status'}
                >
                  <span
                    style={
                      isAgentStatusExpanded
                        ? undefined
                        : {
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }
                    }
                  >
                    {summarizeLiveAgentStatus()}
                  </span>
                </button>
              ) : null}
              {isApplyingArchetype ? (
                <div className="mt-1 text-xs text-base-content/60">
                  Switching oversight regime...
                </div>
              ) : null}
            </div>
            <div className="px-3 pt-2">
              <div className="flex items-start justify-between gap-2">
                {shouldShowBadge ? (
                  <button
                    className="btn btn-warning btn-xs"
                    onClick={() => setShowApprovalOverlay((prev) => !prev)}
                    type="button"
                  >
                    Approvals ({pendingApprovalCount})
                  </button>
                ) : null}
              </div>
            </div>

            {approvedPlan &&
            (runtimeStatus.executionState === 'paused_by_user' || runtimeStatus.executionState === 'paused_by_system_soft') ? (
              <div className="mx-3 mb-2 flex justify-end">
                <button
                  className="inline-flex items-center gap-2 rounded-full border border-base-300 bg-base-100 px-3 py-1.5 text-xs font-medium text-base-content shadow-sm transition hover:border-warning/40 hover:bg-base-100/90"
                  onClick={() => {
                    runtimeInteractionSignal('inspect_plan');
                    setRemainingPlanDraftSteps(remainingPlanTail);
                    setEditingRemainingStepIndex(null);
                    setEditingRemainingPlan(false);
                    setShowInspectPlanModal(true);
                  }}
                  type="button"
                >
                  <span className="h-2 w-2 rounded-full bg-warning" />
                  Plan Studio
                </button>
              </div>
            ) : null}

            {haltReason ? (
              <div className="mx-3 mb-2 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-content">
                {haltReason}
              </div>
            ) : null}

            {runtimeStatus.softPause?.active ? (
              <div className="mx-3 mb-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs">
                <div className="font-semibold text-base-content">Next action will execute...</div>
                <div className="mt-1 text-base-content/80">
                  Countdown active ({Math.max(0, Math.ceil((runtimeStatus.softPause.endsAt - softPauseNow) / 1000))}s)
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => submitSoftPauseDecision('continue_now')}
                    type="button"
                  >
                    Continue now
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => submitSoftPauseDecision('pause')}
                    type="button"
                  >
                    Pause
                  </button>
                </div>
              </div>
            ) : null}

            {!isStructuralAmplificationArchetype && activePanel === 'conversation' && (
              <div
                ref={outputRef}
                className="morph-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
              >
                {isSupervisoryCoExecutionArchetype ? (
                  <MessageDisplay
                    messages={supervisoryLeadingMessages}
                    streamingSegments={{}}
                    isStreaming={false}
                    conversationStyle="chat"
                  />
                ) : null}
                {isSupervisoryCoExecutionArchetype && approvedPlan ? (
                  <SupervisoryPlanBlocks
                    planSteps={approvedPlanSteps}
                    taskNodes={supervisoryActualSteps}
                    taskNodePlanIndices={supervisoryPlanIndices}
                    visibleUntilIndex={supervisoryVisibleUntilIndex}
                  />
                ) : null}
                <MessageDisplay
                  messages={
                    isSupervisoryCoExecutionArchetype
                      ? supervisoryTrailingMessages
                      : isRiskGatedArchetype
                        ? riskGatedConversationMessages
                        : messages
                  }
                  streamingSegments={
                    isSupervisoryCoExecutionArchetype
                      ? supervisoryStreamingSegments
                      : isRiskGatedArchetype
                        ? riskGatedStreamingSegments
                        : streamingSegments
                  }
                  isStreaming={isStreaming}
                  conversationStyle={
                    isRiskGatedArchetype || isActionConfirmationArchetype || isSupervisoryCoExecutionArchetype
                      ? 'chat'
                      : 'default'
                  }
                />
              </div>
            )}

            {isStructuralAmplificationArchetype && activePanel === 'oversight' && (
              <div className="morph-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                {currentPrompt ? (
                  <div className="mx-3 mb-3 rounded-2xl border border-base-300 bg-base-100/90 px-3 py-3">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/45">
                      Your Request
                    </div>
                    <div className="text-sm leading-6 text-base-content/85">
                      {currentPrompt}
                    </div>
                  </div>
                ) : null}
                {enableTaskGraph && (
                  <TaskExecutionGraph
                    nodes={taskNodes}
                    contentGranularity={contentGranularity}
                    informationDensity={informationDensity}
                    colorEncoding={colorEncoding}
                    monitoringContentScope={monitoringContentScope}
                    explanationAvailability={explanationAvailability}
                    explanationFormat={explanationFormat}
                    onTraceNodeExpanded={() => runtimeInteractionSignal('expand_trace_node')}
                    onRepeatedTraceExpansion={() => runtimeInteractionSignal('repeated_trace_expansion')}
                    onRepeatedScrollBackward={() => runtimeInteractionSignal('repeated_scroll_backward')}
                    onRiskLabelHover={(durationMs) => runtimeInteractionSignal('hover_risk_label', durationMs)}
                    onThinkingTooltipVisibilityChange={setThinkingTooltipRect}
                  />
                )}
                {!enableAgentFocus && !enableTaskGraph && (
                  <div className="px-1 py-2 text-sm text-base-content/70">
                    Oversight panel is empty for current mechanism settings.
                  </div>
                )}
              </div>
            )}
          </div>

          {shouldShowOverlay ? (
            <div
              className="pointer-events-none fixed inset-x-4 bottom-24 z-30"
              style={approvalOverlayBottomPx !== null ? { bottom: `${approvalOverlayBottomPx}px` } : undefined}
            >
              <div
                ref={approvalOverlayRef}
                className={`pointer-events-auto overflow-y-auto ${
                  isActionConfirmationArchetype
                    ? 'max-h-[34rem]'
                    : hasSupervisoryPlanStepApproval
                      ? 'max-h-[25.2rem]'
                    : isRiskGatedArchetype
                      ? 'max-h-[27rem]'
                      : 'max-h-72'
                }`}
              >
                {approvalRequests.map(req => (
                  <ApprovalRequest
                    key={req.requestId}
                    requestId={req.requestId}
                    toolName={req.toolName}
                    toolInput={req.toolInput}
                    reason={req.reason}
                    onApprove={handleApprove}
                    onApproveSeries={
                      req.approvalVariant === 'default'
                        ? handleApproveSeries
                        : undefined
                    }
                    onApproveSite={req.approvalVariant === 'action-confirmation' ? handleApproveSite : undefined}
                    onReject={handleReject}
                    onDismiss={handleDismissWarning}
                    onEdit={undefined}
                    onRetry={undefined}
                    onRollback={undefined}
                    onPlanStepSave={
                      req.approvalVariant === 'supervisory-plan-step'
                        ? updateSupervisoryPlanStep
                        : undefined
                    }
                    onPlanStepReset={
                      req.approvalVariant === 'supervisory-plan-step'
                        ? resetSupervisoryPlanStep
                        : undefined
                    }
                    compact={informationDensity === 'compact'}
                    variant={req.approvalVariant || 'default'}
                    originalPlanStepText={supervisoryPlanStepOriginals[req.requestId]}
                    planStepBusy={planStepUpdateRequestId === req.requestId}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {planReviewRequest ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-44 z-40">
              <div className="pointer-events-auto flex max-h-[62vh] flex-col rounded-lg border border-warning/40 bg-base-100 p-4 shadow-xl">
                <div className="mb-2 text-sm font-semibold">Plan Review</div>
                <div className="mb-2 text-xs whitespace-pre-wrap text-base-content/80">{planReviewRequest.planSummary}</div>
                {editedPlanSteps.length > 0 ? (
                  <div className="mb-3 flex-1 space-y-2 overflow-y-auto pr-1">
                    {editedPlanSteps.map((line, idx) => (
                      <div
                        key={`plan-line-${idx}`}
                        className={`grid grid-cols-[64px_1fr_auto] items-start gap-2 rounded-md border border-transparent p-1 transition ${draggedPlanStepIndex === idx ? 'bg-base-200/70' : 'hover:border-base-300/80'}`}
                        draggable
                        onDragStart={() => setDraggedPlanStepIndex(idx)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (draggedPlanStepIndex === null) return;
                          movePlanStep(draggedPlanStepIndex, idx);
                          setDraggedPlanStepIndex(null);
                        }}
                        onDragEnd={() => setDraggedPlanStepIndex(null)}
                      >
                        <div className="pt-2 text-xs font-semibold text-base-content/80">Step {idx + 1}</div>
                        {editingPlanStepIndex === idx ? (
                          <textarea
                            autoFocus
                            className="textarea textarea-bordered min-h-[5rem] w-full resize-y text-xs"
                            value={line}
                            onBlur={() => setEditingPlanStepIndex(null)}
                            onChange={(e) => handlePlanStepChange(idx, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setEditingPlanStepIndex(null);
                              }
                            }}
                            rows={3}
                          />
                        ) : (
                          <button
                            type="button"
                            onDoubleClick={() => setEditingPlanStepIndex(idx)}
                            className="min-h-[5rem] rounded-md bg-base-200 px-3 py-2 text-left text-xs text-base-content/90 transition hover:bg-base-200/80"
                            title="Double-click to edit this step"
                          >
                            {line.trim() || 'Double-click to add this step.'}
                          </button>
                        )}
                        <div className="pt-1">
                          <button
                            className="btn btn-ghost btn-xs text-error hover:bg-error/10"
                            onClick={() => handlePlanStepRemove(idx)}
                            type="button"
                            aria-label={`Delete step ${idx + 1}`}
                          >
                            <FontAwesomeIcon icon={faTrash} />
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-base-300 px-3 py-2 text-xs font-medium text-base-content/70 transition hover:border-warning/40 hover:text-base-content"
                      onClick={handlePlanStepAdd}
                      type="button"
                    >
                      <FontAwesomeIcon icon={faPlus} />
                      Add Step
                    </button>
                  </div>
                ) : (
                  <div className="mb-3">
                    <button
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-base-300 px-3 py-3 text-xs font-medium text-base-content/70 transition hover:border-warning/40 hover:text-base-content"
                      onClick={handlePlanStepAdd}
                      type="button"
                    >
                      <FontAwesomeIcon icon={faPlus} />
                      Add Step
                    </button>
                  </div>
                )}
                <div className="shrink-0 flex flex-wrap gap-2 border-t border-base-300 pt-3">
                  <button
                    className="btn btn-xs btn-success min-w-[110px] flex-1"
                    onClick={handlePlanReviewApprove}
                    type="button"
                  >
                    Approve Plan
                  </button>
                  <button className="btn btn-xs btn-error min-w-[110px] flex-1" onClick={handlePlanReviewReject} type="button">
                    Reject Plan
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {showInspectPlanModal && approvedPlan ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-44 z-40">
              <div className="pointer-events-auto flex max-h-[62vh] flex-col rounded-lg border border-base-300 bg-base-100 p-4 shadow-xl">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Plan Studio</div>
                  <button
                    className="btn btn-xs btn-ghost"
                    onClick={() => {
                      setShowInspectPlanModal(false);
                      setEditingRemainingPlan(false);
                      setRemainingPlanDraftSteps(remainingPlanTail);
                      setEditingRemainingStepIndex(null);
                    }}
                    type="button"
                  >
                    Close
                  </button>
                </div>
                <div className="mb-2 text-xs whitespace-pre-wrap text-base-content/75">{approvedPlan.summary}</div>
                <div className="mb-3 flex gap-2">
                  <button
                    className={`btn btn-xs ${!editingRemainingPlan ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setEditingRemainingPlan(false)}
                    type="button"
                  >
                    Overview
                  </button>
                  <button
                    className={`btn btn-xs ${editingRemainingPlan ? 'btn-warning' : 'btn-ghost'}`}
                    onClick={() => {
                      setRemainingPlanDraftSteps(remainingPlanTail);
                      setEditingRemainingStepIndex(null);
                      setEditingRemainingPlan(true);
                    }}
                    type="button"
                  >
                    Edit Remaining
                  </button>
                </div>
                {inspectPlanLoading ? (
                  <div className="mb-2 text-xs text-base-content/60">Assessing plan progress...</div>
                ) : null}
                {inspectPlanError ? (
                  <div className="mb-2 text-xs text-warning">Plan assessment error: {inspectPlanError}</div>
                ) : null}
                {!editingRemainingPlan ? (
                  <div className="space-y-3 overflow-y-auto pr-1">
                    {approvedPlan.steps.map((step, idx) => {
                      const progress = inspectPlanView.steps[idx];
                      return (
                        <div key={`inspect-plan-${idx}`} className="rounded-lg border border-base-300 bg-base-100/80 px-3 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-base-content/50">
                              Plan {idx + 1}
                            </div>
                            {progress ? (
                              <span
                                className={badgeClassName(
                                  progress.status === 'completed'
                                    ? 'success'
                                    : progress.status === 'current'
                                      ? 'info'
                                      : 'neutral'
                                )}
                              >
                                {progress.status}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 text-sm leading-6 text-base-content">{step}</div>
                          {progress?.reason ? (
                            <div className="mt-2 text-xs leading-5 text-base-content/65">
                              {progress.reason}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="overflow-y-auto pr-1">
                    <div className="mb-3 text-xs text-base-content/70">
                      Steps before {currentPlanStepIndex + 1} stay fixed. Double-click a step to edit it, drag to reorder it, or remove steps you no longer want.
                    </div>
                    <div className="space-y-2">
                      {remainingPlanDraftSteps.map((step, idx) => (
                        <div
                          key={`remaining-step-${idx}`}
                          className={`grid grid-cols-[64px_1fr_auto] items-start gap-2 rounded-md border border-transparent p-1 transition ${draggedRemainingStepIndex === idx ? 'bg-base-200/70' : 'hover:border-base-300/80'}`}
                          draggable
                          onDragStart={() => setDraggedRemainingStepIndex(idx)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (draggedRemainingStepIndex === null) return;
                            moveRemainingPlanStep(draggedRemainingStepIndex, idx);
                            setDraggedRemainingStepIndex(null);
                          }}
                          onDragEnd={() => setDraggedRemainingStepIndex(null)}
                        >
                          <div className="pt-2 text-xs font-semibold text-base-content/70">
                            Step {remainingPlanPrefix.length + idx + 1}
                          </div>
                          {editingRemainingStepIndex === idx ? (
                            <textarea
                              autoFocus
                              className="textarea textarea-bordered min-h-[5rem] w-full resize-y text-xs"
                              value={step}
                              onBlur={() => setEditingRemainingStepIndex(null)}
                              onChange={(e) => handleRemainingPlanStepChange(idx, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  setEditingRemainingStepIndex(null);
                                }
                              }}
                              rows={3}
                            />
                          ) : (
                            <button
                              type="button"
                              onDoubleClick={() => setEditingRemainingStepIndex(idx)}
                              className="min-h-[5rem] rounded-md border border-base-300 bg-base-200/60 px-3 py-2 text-left text-xs text-base-content/90 transition hover:border-warning/40 hover:bg-base-200"
                              title="Double-click to edit this step"
                            >
                              {step.trim() || 'Double-click to add this step.'}
                            </button>
                          )}
                          <div className="pt-1">
                            <button
                              className="btn btn-ghost btn-xs text-error hover:bg-error/10"
                              onClick={() => handleRemainingPlanStepRemove(idx)}
                              type="button"
                              aria-label={`Delete step ${remainingPlanPrefix.length + idx + 1}`}
                            >
                              <FontAwesomeIcon icon={faTrash} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-base-300 px-3 py-2 text-xs font-medium text-base-content/70 transition hover:border-warning/40 hover:text-base-content"
                        onClick={handleRemainingPlanStepAdd}
                        type="button"
                      >
                        <FontAwesomeIcon icon={faPlus} />
                        Add Step
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn btn-xs btn-warning" onClick={handleRemainingPlanSubmit} type="button">
                        Save Remaining Plan
                      </button>
                      <button
                        className="btn btn-xs btn-ghost"
                        onClick={() => {
                          setEditingRemainingPlan(false);
                          setRemainingPlanDraftSteps(remainingPlanTail);
                          setEditingRemainingStepIndex(null);
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}


          <div className="pb-1">
            <PromptForm
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              onPause={pauseExecution}
              onResume={resumeExecution}
              isProcessing={isProcessing}
              canPause={canPause}
              canResume={canResume}
              tabStatus={tabStatus}
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col flex-grow items-center justify-center">
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold mb-2">No LLM provider configured</h2>
            <p className="text-gray-600 mb-4">
              You need to configure an LLM provider before you can use BrowserBee.
            </p>
            <button
              onClick={navigateToOptions}
              className="btn btn-primary"
            >
              Configure Providers
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
