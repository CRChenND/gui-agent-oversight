import { LLMProvider, StreamChunk } from "../models/providers/types";
import { ErrorHandler } from "./ErrorHandler";
import { PromptManager } from "./PromptManager";
import { trimHistory } from "./TokenManager";
import { ToolManager } from "./ToolManager";
import { requestApproval } from "./approvalManager";
import { emitAgentThinking } from "./thinking/thinkingEmitter";
import { buildThinkingSummary, createStepId } from "./thinking/thinkingSummary";
import {
  getOversightStorageQueryDefaults,
  getOversightParameterStorageKey,
  INTERVENTION_GATE_MECHANISM_ID,
  mapStorageToOversightSettings,
} from "../oversight/registry";
import {
  inferRiskAssessment,
  INITIAL_ADAPTIVE_GATE_STATE,
  shouldPromptByGatePolicy,
  updateAdaptiveStateFromDecision,
  updateAdaptiveStateFromStep,
  type AdaptiveGateState,
  type InterventionGatePolicy,
} from "../oversight/riskAssessment";

// Constants
const MAX_STEPS = 50;            // prevent infinite loops

const TASK_COMPLETE_REGEX = /<task_status>\s*complete\s*<\/task_status>/i;
const FINAL_RESPONSE_REGEX = /<final_response>([\s\S]*?)<\/final_response>/i;
const MAX_OUTPUT_TOKENS = 1024;  // max tokens for LLM response
type LlmImpact = 'low' | 'medium' | 'high';
type ControlMode = 'approve_all' | 'risky_only' | 'step_through';
type TimingPolicy = 'pre_action' | 'pre_navigation' | 'post_action';
type ApprovedPlan = { summary: string; steps: string[] };
type PlanStepDisposition = 'current' | 'next' | 'out_of_plan';
type PlanEvidenceStatus = 'completed' | 'cancelled' | 'error';
export type ExecutionTerminalStatus = 'completed' | 'stopped' | 'cancelled' | 'max_steps' | 'failed';
type PlanExecutionEvidence = {
  planStepIndex: number;
  toolName: string;
  toolInput: string;
  thinking: string;
  status: PlanEvidenceStatus;
};

/**
 * Callback interface for execution
 */
export interface ExecutionCallbacks {
  onLlmChunk?: (s: string) => void;
  onLlmOutput: (s: string) => void;
  onToolOutput: (s: string) => void;
  onComplete: (result?: { status: ExecutionTerminalStatus; reason?: string }) => void;
  onError?: (error: any) => void;
  onToolStart?: (
    stepId: string,
    toolName: string,
    toolInput: string,
    planStepIndex?: number,
    stepDescription?: string
  ) => void;
  onAfterToolStart?: (payload: { stepId: string; toolName: string; toolInput: string; thinking: string }) => Promise<void>;
  onToolEnd?: (stepId: string, result: string) => void;
  onToolError?: (stepId: string, toolName: string, toolInput: string, error: string) => void;
  onRiskSignal?: (stepId: string, toolName: string, payload: Record<string, unknown>) => void;
  onSegmentComplete?: (segment: string) => void;
  onFallbackStarted?: () => void;
  onPlanGenerated?: (payload: {
    summary: string;
    steps: string[];
  }) => void;
  onPlanReviewRequired?: (payload: {
    stepId: string;
    toolName: string;
    toolInput: string;
    planSummary: string;
    plan?: string[];
  }) => Promise<{ decision: 'approve' | 'edit' | 'reject'; editedPlan?: string }>;
  onPlanStepApprovalRequired?: (payload: {
    stepId: string;
    planStepIndex: number;
    planStepText: string;
    thinking?: string;
    toolName: string;
    toolInput: string;
  }) => Promise<{ decision: 'accept' | 'reject' }>;
  onWaitForExecutionPermission?: () => Promise<{ allowed: boolean; reason?: string }>;
  onPrepareModelStep?: () => Promise<{ amplificationState: 'normal' | 'amplified'; enteredReason?: string }>;
  onBeforeToolInvocation?: (payload: { stepId: string; toolName: string }) => Promise<{ allowed: boolean; reason?: string }>;
  onAfterToolCommitted?: () => Promise<void>;
  classifyAmplifiedRisk?: (payload: { toolName: string; toolInput: string }) => {
    effect_type: 'reversible' | 'irreversible';
    scope: 'local' | 'external';
    data_flow: 'disclosure' | 'none';
  } | null;
}

/**
 * Adapter for handling callbacks in both streaming and non-streaming modes
 */
class CallbackAdapter {
  private originalCallbacks: ExecutionCallbacks;
  private isStreaming: boolean;
  private buffer: string = '';

  constructor(callbacks: ExecutionCallbacks, isStreaming: boolean) {
    this.originalCallbacks = callbacks;
    this.isStreaming = isStreaming;
  }

  get adaptedCallbacks(): ExecutionCallbacks {
    return {
      onLlmChunk: this.handleLlmChunk.bind(this),
      onLlmOutput: this.originalCallbacks.onLlmOutput,
      onToolOutput: this.originalCallbacks.onToolOutput,
      onComplete: this.handleComplete.bind(this),
      onError: this.originalCallbacks.onError,
      onToolStart: this.originalCallbacks.onToolStart,
      onAfterToolStart: this.originalCallbacks.onAfterToolStart,
      onToolEnd: this.originalCallbacks.onToolEnd,
      onToolError: this.originalCallbacks.onToolError,
      onRiskSignal: this.originalCallbacks.onRiskSignal,
      onSegmentComplete: this.originalCallbacks.onSegmentComplete,
      onFallbackStarted: this.originalCallbacks.onFallbackStarted,
      onPlanGenerated: this.originalCallbacks.onPlanGenerated,
      onPlanReviewRequired: this.originalCallbacks.onPlanReviewRequired,
      onPlanStepApprovalRequired: this.originalCallbacks.onPlanStepApprovalRequired,
      onWaitForExecutionPermission: this.originalCallbacks.onWaitForExecutionPermission,
      onPrepareModelStep: this.originalCallbacks.onPrepareModelStep,
      onBeforeToolInvocation: this.originalCallbacks.onBeforeToolInvocation,
      onAfterToolCommitted: this.originalCallbacks.onAfterToolCommitted,
      classifyAmplifiedRisk: this.originalCallbacks.classifyAmplifiedRisk,
    };
  }

  private handleLlmChunk(chunk: string): void {
    if (this.isStreaming && this.originalCallbacks.onLlmChunk) {
      // Pass through in streaming mode
      this.originalCallbacks.onLlmChunk(chunk);
    } else {
      // Buffer in non-streaming mode
      this.buffer += chunk;
    }
  }

  private handleComplete(result?: { status: ExecutionTerminalStatus; reason?: string }): void {
    // In non-streaming mode, emit the full buffer at completion
    if (!this.isStreaming && this.buffer.length > 0) {
      this.originalCallbacks.onLlmOutput(this.buffer);
      this.buffer = '';
    }

    this.originalCallbacks.onComplete(result);
  }
}

/**
 * ExecutionEngine handles streaming execution logic, non-streaming execution logic,
 * and fallback mechanisms.
 */
export class ExecutionEngine {
  private llmProvider: LLMProvider;
  private toolManager: ToolManager;
  private promptManager: PromptManager;
  private errorHandler: ErrorHandler;
  private adaptiveGateState: AdaptiveGateState = INITIAL_ADAPTIVE_GATE_STATE;
  private liveMessages: any[] | null = null;
  private currentTaskPrompt = '';
  private approvedPlanState: ApprovedPlan | null = null;
  private currentPlanStepIndex = 0;
  private highestAcceptedPlanStepIndex = -1;
  private lastCompletionCheckPlanStepIndex = 0;
  private executedPlanEvidence: PlanExecutionEvidence[] = [];

  private parseTaskCompletion(text: string): { complete: boolean; finalResponse: string | null } {
    if (!TASK_COMPLETE_REGEX.test(text)) {
      return { complete: false, finalResponse: null };
    }

    const finalResponseMatch = text.match(FINAL_RESPONSE_REGEX);
    const finalResponse = finalResponseMatch?.[1]?.trim() || null;
    return { complete: true, finalResponse };
  }

  private getPendingPlanCompletionReason(): string | null {
    if (!this.approvedPlanState?.steps.length) {
      return null;
    }

    const lastPlanStepIndex = this.approvedPlanState.steps.length - 1;
    if (this.currentPlanStepIndex < lastPlanStepIndex) {
      const nextStepText = this.approvedPlanState.steps[this.currentPlanStepIndex + 1] || '(unknown next step)';
      return `Approved plan step ${this.currentPlanStepIndex + 2} is still pending: ${nextStepText}`;
    }

    if (this.highestAcceptedPlanStepIndex >= 0 && this.highestAcceptedPlanStepIndex < lastPlanStepIndex) {
      const pendingApprovalStep = this.approvedPlanState.steps[this.highestAcceptedPlanStepIndex + 1] || '(unknown step)';
      return `Approved plan step ${this.highestAcceptedPlanStepIndex + 2} has not been accepted/executed yet: ${pendingApprovalStep}`;
    }

    return null;
  }

  private parsePlanProgressAssessment(
    rawText: string,
    expectedStepCount: number
  ): {
    isFullyCompleted: boolean;
    steps: Array<{ status: 'completed' | 'current' | 'pending'; reason: string }>;
  } {
    const fallback = {
      isFullyCompleted: false,
      steps: Array.from({ length: expectedStepCount }, () => ({
        status: 'pending' as const,
        reason: 'Assessment unavailable.',
      })),
    };

    const normalized = rawText.trim();
    const jsonStart = normalized.indexOf('{');
    const jsonEnd = normalized.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1)) as {
        steps?: Array<{ status?: string; reason?: string }>;
      };
      const steps = Array.from({ length: expectedStepCount }, (_, index) => {
        const incoming = parsed.steps?.[index];
        const status: 'completed' | 'current' | 'pending' =
          incoming?.status === 'completed' || incoming?.status === 'current' || incoming?.status === 'pending'
            ? incoming.status
            : 'pending';
        const reason =
          typeof incoming?.reason === 'string' && incoming.reason.trim().length > 0
            ? incoming.reason.trim()
            : 'No clear evidence found.';
        return { status, reason };
      });
      return {
        isFullyCompleted: expectedStepCount > 0 && steps.every((step) => step.status === 'completed'),
        steps,
      };
    } catch {
      return fallback;
    }
  }

  private isObservationTool(toolName: string): boolean {
    return /read|snapshot|query|screenshot|accessible_tree|get_title/i.test(toolName);
  }

  private async assessApprovedPlanCompletion(): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.approvedPlanState?.steps.length) {
      return { allowed: true };
    }

    const evidenceByStep = new Map<number, PlanExecutionEvidence[]>();
    for (const evidence of this.executedPlanEvidence) {
      const bucket = evidenceByStep.get(evidence.planStepIndex) || [];
      bucket.push(evidence);
      evidenceByStep.set(evidence.planStepIndex, bucket);
    }

    for (let index = 0; index < this.approvedPlanState.steps.length; index += 1) {
      const evidence = evidenceByStep.get(index) || [];
      const hasCompletedEvidence = evidence.some((item) => item.status === 'completed');
      if (!hasCompletedEvidence) {
        return {
          allowed: false,
          reason: `Approved plan step ${index + 1} has no completed execution evidence yet: ${this.approvedPlanState.steps[index]}`,
        };
      }

      const lastCompletedEvidence = [...evidence].reverse().find((item) => item.status === 'completed');
      if (lastCompletedEvidence && !this.isObservationTool(lastCompletedEvidence.toolName)) {
        const hasVerificationAfterLastAction = evidence.some(
          (item) =>
            item.status === 'completed' &&
            this.isObservationTool(item.toolName) &&
            this.executedPlanEvidence.indexOf(item) > this.executedPlanEvidence.indexOf(lastCompletedEvidence)
        );
        if (!hasVerificationAfterLastAction) {
          return {
            allowed: false,
            reason:
              `Approved plan step ${index + 1} still needs verification after the last page-changing action ` +
              `(${lastCompletedEvidence.toolName}). Observe the page and confirm the remaining required work is done.`,
          };
        }
      }
    }

    const systemPrompt =
      'You are an execution-progress evaluator.\n' +
      'Given an approved plan and observed agent execution steps, determine whether every plan step is completed.\n' +
      'Rules:\n' +
      '1) Use only provided evidence.\n' +
      '2) For each plan step return exactly one status: completed | current | pending.\n' +
      '3) Mark a step completed only if the evidence strongly supports that the step was actually carried out.\n' +
      '4) Keep reasons concise and evidence-based.\n' +
      '5) Return valid JSON only.';
    const userPrompt = JSON.stringify(
      {
        task: 'Assess whether the approved plan is fully completed.',
        requiredOutputShape: {
          steps: 'Array<{status: "completed"|"current"|"pending", reason: string}>',
        },
        planSteps: this.approvedPlanState.steps.map((step, idx) => ({ stepNumber: idx + 1, text: step })),
        executionEvidence: this.executedPlanEvidence.map((step, index) => ({
          index,
          planStepIndex: step.planStepIndex + 1,
          status: step.status,
          toolName: step.toolName,
          toolInput: step.toolInput,
          thinking: step.thinking,
        })),
      },
      null,
      2
    );

    try {
      const raw = await this.collectModelText(systemPrompt, [{ role: 'user', content: userPrompt }]);
      const assessment = this.parsePlanProgressAssessment(raw, this.approvedPlanState.steps.length);
      if (assessment.isFullyCompleted) {
        return { allowed: true };
      }
      const pendingIndex = assessment.steps.findIndex((step) => step.status !== 'completed');
      return {
        allowed: false,
        reason:
          pendingIndex >= 0
            ? `Approved plan step ${pendingIndex + 1} is not yet complete: ${assessment.steps[pendingIndex].reason}`
            : 'Plan completion assessment did not find enough evidence to finish.',
      };
    } catch (error) {
      return {
        allowed: false,
        reason: `Plan completion assessment failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  constructor(
    llmProvider: LLMProvider,
    toolManager: ToolManager,
    promptManager: PromptManager,
    errorHandler: ErrorHandler
  ) {
    this.llmProvider = llmProvider;
    this.toolManager = toolManager;
    this.promptManager = promptManager;
    this.errorHandler = errorHandler;
  }

  updateApprovedPlanGuidanceDuringRun(text: string): void {
    const normalized = text.trim();
    this.promptManager.setApprovedPlanGuidance(normalized);
    this.applyApprovedPlanText(normalized);
    if (!normalized) return;
    this.rewriteLiveMessagesForApprovedPlan(normalized);
  }

  /**
   * Main execution method with fallback support
   */
  async executePromptWithFallback(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = []
  ): Promise<void> {
    const streamingSupported = await this.errorHandler.isStreamingSupported();
    const isStreaming = streamingSupported && callbacks.onLlmChunk !== undefined;

    try {
      // Use the execution method with appropriate streaming mode
      await this.executePrompt(prompt, callbacks, initialMessages, isStreaming);
    } catch (error) {
      console.warn("Execution failed, attempting fallback:", error);

      // Notify about fallback before switching modes
      if (callbacks.onFallbackStarted) {
        callbacks.onFallbackStarted();
      }

      // Check if this is a retryable error (rate limit or overloaded)
      if (this.errorHandler.isRetryableError(error)) {
        console.log("Retryable error detected in fallback handler:", error);
        // Ensure the error callback is called even during fallback
        if (callbacks.onError) {
          callbacks.onError(error);
        }
      }

      // Continue with fallback using non-streaming mode
      await this.executePrompt(prompt, callbacks, initialMessages, false);
    }
  }

  /**
   * Helper function to decode escaped HTML entities in a string
   * @param text The text to decode
   * @returns The decoded text
   */
  private decodeHtmlEntities(text: string): string {
    // Replace Unicode escape sequences with actual characters
    return text
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\u003c/g, '<')
      .replace(/\u003e/g, '>');
  }

  /**
   * Initialize message history with the prompt
   */
  private initializeMessages(prompt: string, initialMessages: any[]): any[] {
    // Use initial messages if provided, otherwise start with just the prompt
    const messages: any[] = initialMessages.length > 0
      ? [...initialMessages]
      : [{ role: "user", content: prompt }];

    // If we have initial messages and the last one isn't the current prompt,
    // add the current prompt
    if (initialMessages.length > 0 &&
        (messages[messages.length - 1].role !== "user" ||
         messages[messages.length - 1].content !== prompt)) {
      messages.push({ role: "user", content: prompt });
    }

    return messages;
  }

  private isPlanControlMessage(message: any): boolean {
    if (!message || message.role !== 'user' || typeof message.content !== 'string') return false;
    const content = message.content.trim();
    return (
      /^follow this approved plan guidance for the full task:/i.test(content) ||
      /^plan approved\. follow this plan throughout the task/i.test(content) ||
      /^updated plan guidance replaces every earlier approved plan instruction\./i.test(content) ||
      /^original user request is background context only\./i.test(content) ||
      /^approved plan override:/i.test(content)
    );
  }

  private isStandaloneOriginalPromptMessage(message: any): boolean {
    return (
      !!message &&
      message.role === 'user' &&
      typeof message.content === 'string' &&
      this.currentTaskPrompt.length > 0 &&
      message.content.trim() === this.currentTaskPrompt.trim()
    );
  }

  private rewriteLiveMessagesForApprovedPlan(planText: string): void {
    if (!this.liveMessages) return;

    const preservedMessages = this.liveMessages.filter(
      (message) => !this.isPlanControlMessage(message) && !this.isStandaloneOriginalPromptMessage(message)
    );

    const rewrittenMessages = [...preservedMessages];
    if (this.currentTaskPrompt.trim()) {
      rewrittenMessages.push({
        role: 'user',
        content:
          'Original user request is background context only. Use it to understand the goal and constraints, ' +
          'but do not treat it as the active execution instruction if it conflicts with the approved plan:\n' +
          this.currentTaskPrompt.trim(),
      });
    }
    rewrittenMessages.push({
      role: 'user',
      content:
        'Approved plan override:\n' +
        'The latest approved plan is authoritative for all remaining execution steps. ' +
        'If any earlier user instruction conflicts with this plan on sequencing or scope, follow the approved plan.\n' +
        planText,
    });

    this.liveMessages = trimHistory(rewrittenMessages);
  }

  private async getInterventionGateConfig(): Promise<{
    enabled: boolean;
    policy: InterventionGatePolicy;
    controlMode: ControlMode;
    timingPolicy: TimingPolicy;
  }> {
    const gatePolicyKey = getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'gatePolicy');
    const controlModeKey = getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'controlMode');
    const timingPolicyKey = getOversightParameterStorageKey(INTERVENTION_GATE_MECHANISM_ID, 'timingPolicy');
    const storage = await chrome.storage.sync.get({
      ...getOversightStorageQueryDefaults(),
      [gatePolicyKey]: 'impact',
      [controlModeKey]: 'risky_only',
      [timingPolicyKey]: 'pre_action',
    });
    const settings = mapStorageToOversightSettings(storage as Record<string, unknown>);
    const rawPolicy = storage[gatePolicyKey];
    const policy =
      rawPolicy === 'never' || rawPolicy === 'always' || rawPolicy === 'impact' || rawPolicy === 'adaptive'
        ? rawPolicy
        : 'impact';
    const rawControlMode = storage[controlModeKey];
    const controlMode =
      rawControlMode === 'approve_all' || rawControlMode === 'risky_only' || rawControlMode === 'step_through'
        ? rawControlMode
        : 'risky_only';
    const rawTimingPolicy = storage[timingPolicyKey];
    const timingPolicy =
      rawTimingPolicy === 'pre_action' || rawTimingPolicy === 'pre_navigation' || rawTimingPolicy === 'post_action'
        ? rawTimingPolicy
        : 'pre_action';

    return {
      enabled: settings[INTERVENTION_GATE_MECHANISM_ID],
      policy,
      controlMode,
      timingPolicy,
    };
  }

  private extractTag(text: string, tagName: string): string | undefined {
    const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = text.match(pattern);
    if (!match) return undefined;
    const value = match[1].trim();
    return value.length > 0 ? value : undefined;
  }

  private parseModelStepMetadata(accumulatedText: string): {
    thinkingSummary?: string;
    impact?: LlmImpact;
    impactRationale?: string;
    plannedNextStep?: string;
    plannedAlternative?: string;
    plannedRationale?: string;
  } {
    const thinkingSummary = this.extractTag(accumulatedText, 'thinking_summary');
    const rawImpact = this.extractTag(accumulatedText, 'impact');
    const impact =
      rawImpact === 'low' || rawImpact === 'medium' || rawImpact === 'high' ? rawImpact : undefined;
    const impactRationale = this.extractTag(accumulatedText, 'impact_rationale');
    const plannedNextStep = this.extractScaffoldSection(accumulatedText, 'Next Step I Plan To Do', [
      'Alternative',
      'Why I choose A over B',
    ]);
    const plannedAlternative = this.extractScaffoldSection(accumulatedText, 'Alternative', ['Why I choose A over B']);
    const plannedRationale = this.extractScaffoldSection(accumulatedText, 'Why I choose A over B', []);
    return {
      thinkingSummary,
      impact,
      impactRationale,
      plannedNextStep,
      plannedAlternative,
      plannedRationale,
    };
  }

  private extractScaffoldSection(text: string, label: string, stopLabels: string[]): string | undefined {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stopPattern = stopLabels
      .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const boundaryPattern =
      stopPattern.length > 0
        ? `(?=\\n\\s*(?:${stopPattern})\\s*:|\\n\\s*<tool>|$)`
        : `(?=\\n\\s*<tool>|$)`;
    const regex = new RegExp(`${escapedLabel}\\s*:\\s*([\\s\\S]*?)${boundaryPattern}`, 'i');
    const match = text.match(regex);
    if (!match) return undefined;
    const value = match[1]
      .replace(/<thinking_summary>[\s\S]*?<\/thinking_summary>/gi, ' ')
      .replace(/<impact>[\s\S]*?<\/impact>/gi, ' ')
      .replace(/<impact_rationale>[\s\S]*?<\/impact_rationale>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return value.length > 0 ? value : undefined;
  }

  private hasRequiredAmplifiedScaffold(text: string): boolean {
    return (
      text.includes('Next Step I Plan To Do:') &&
      text.includes('Alternative:') &&
      text.includes('Why I choose A over B:')
    );
  }

  private async collectModelText(systemPrompt: string, messages: any[]): Promise<string> {
    let accumulated = '';
    const stream = this.llmProvider.createMessage(systemPrompt, messages);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        accumulated += chunk.text;
      }
    }
    return this.decodeHtmlEntities(accumulated).trim();
  }

  private cleanPlanStepText(text: string): string {
    return text
      .replace(/<\/?(thinking_summary|impact|impact_rationale)>/gi, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isDescriptivePlanStep(text: string): boolean {
    if (!text || text.length < 16) return false;
    if (/^(low|medium|high)$/i.test(text)) return false;
    if (/^(thinking_summary|impact|impact_rationale)$/i.test(text)) return false;
    return /[a-zA-Z]/.test(text) && text.includes(' ');
  }

  private extractPlanFromPlannerOutput(text: string): { summary: string; steps: string[] } {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    let summary = '';
    const summaryLine = lines.find((line) => /^plan summary:/i.test(line));
    if (summaryLine) {
      summary = this.cleanPlanStepText(summaryLine.replace(/^plan summary:\s*/i, ''));
    }

    const stepLines = lines
      .filter((line) => /^step\s*\d+\s*:/i.test(line) || /^\d+[.)]\s+/.test(line) || /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^step\s*\d+\s*:\s*/i, ''))
      .map((line) => line.replace(/^\d+[.)]\s+/, ''))
      .map((line) => line.replace(/^[-*]\s+/, ''))
      .map((line) => this.cleanPlanStepText(line))
      .filter((line) => this.isDescriptivePlanStep(line));

    if (!summary) {
      const fallback = lines.find((line) => this.isDescriptivePlanStep(this.cleanPlanStepText(line)));
      summary = fallback ? this.cleanPlanStepText(fallback) : 'Plan generated for this task.';
    }

    return {
      summary,
      steps: Array.from(new Set(stepLines)).slice(0, 6),
    };
  }

  private async generateTaskPlan(prompt: string, messages: any[]): Promise<{ summary: string; steps: string[] }> {
    const plannerSystemPrompt = this.promptManager.getPlanningPrompt();
    const planningMessages = [...messages, { role: 'user', content: `Generate a full plan for:\n${prompt}` }];
    const planningText = await this.collectModelText(plannerSystemPrompt, planningMessages);
    const parsed = this.extractPlanFromPlannerOutput(planningText);
    const steps =
      parsed.steps.length >= 2
        ? parsed.steps
        : this.buildFallbackPlan(prompt, '').map((step) => this.cleanPlanStepText(step));
    return {
      summary: parsed.summary,
      steps,
    };
  }

  private buildFallbackPlan(goal: string, toolName: string): string[] {
    const normalizedGoal = goal.trim() || 'the current user request';
    return [
      `Understand the user goal and constraints for: ${normalizedGoal}.`,
      `Collect and evaluate relevant options using safe, minimal browser actions${toolName ? ` (starting with ${toolName})` : ''}.`,
      'Summarize findings and produce a concise recommendation before moving to execution-critical actions.',
    ];
  }

  private tokenizePlanText(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2);
  }

  private resetApprovedPlanState(): void {
    this.approvedPlanState = null;
    this.currentPlanStepIndex = 0;
    this.highestAcceptedPlanStepIndex = -1;
    this.lastCompletionCheckPlanStepIndex = 0;
  }

  private setApprovedPlanState(plan: ApprovedPlan | null): void {
    if (!plan || plan.steps.length === 0) {
      this.resetApprovedPlanState();
      return;
    }

    this.approvedPlanState = {
      summary: plan.summary,
      steps: Array.from(new Set(plan.steps.map((step) => this.cleanPlanStepText(step)).filter((step) => this.isDescriptivePlanStep(step)))),
    };
    if (this.approvedPlanState.steps.length === 0) {
      this.resetApprovedPlanState();
      return;
    }

    this.currentPlanStepIndex = Math.max(0, Math.min(this.currentPlanStepIndex, this.approvedPlanState.steps.length - 1));
    this.highestAcceptedPlanStepIndex = Math.max(
      this.currentPlanStepIndex,
      Math.min(this.highestAcceptedPlanStepIndex, this.approvedPlanState.steps.length - 1)
    );
    this.lastCompletionCheckPlanStepIndex = Math.max(
      0,
      Math.min(this.lastCompletionCheckPlanStepIndex, this.approvedPlanState.steps.length - 1)
    );
  }

  private applyApprovedPlanText(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      this.resetApprovedPlanState();
      return;
    }

    const parsed = this.extractPlanFromPlannerOutput(normalized);
    const hasExplicitSummary = /^\s*plan summary:/im.test(normalized);
    const nextPlan: ApprovedPlan | null =
      parsed.steps.length > 0
        ? {
            summary:
              (hasExplicitSummary ? parsed.summary : '') || this.approvedPlanState?.summary || 'Approved plan.',
            steps: parsed.steps,
          }
        : null;
    this.setApprovedPlanState(nextPlan);
  }

  private inferPlanStepIndex(args: {
    planSteps: string[];
    currentPlanIndex: number;
    toolName: string;
    toolInput: string;
    thinking: string;
  }): { disposition: PlanStepDisposition; index: number } {
    const { planSteps, currentPlanIndex, toolName, toolInput, thinking } = args;
    if (planSteps.length === 0) return { disposition: 'current', index: 0 };
    const normalizedCurrentIndex = Math.max(0, Math.min(currentPlanIndex, planSteps.length - 1));
    const stepText = [toolName, toolInput, thinking].join(' ');
    const stepTokens = this.tokenizePlanText(stepText);
    if (stepTokens.length === 0) {
      return { disposition: 'current', index: normalizedCurrentIndex };
    }

    const scorePlanStep = (planStepText: string, bias = 0): number => {
      const planTokens = new Set(this.tokenizePlanText(planStepText));
      let score = bias;
      for (const token of stepTokens) {
        if (planTokens.has(token)) score += 1;
      }
      return score;
    };

    const currentScore = scorePlanStep(planSteps[normalizedCurrentIndex], 0.75);
    const nextIndex = Math.min(planSteps.length - 1, normalizedCurrentIndex + 1);
    if (nextIndex === normalizedCurrentIndex) {
      return currentScore >= 1 ? { disposition: 'current', index: normalizedCurrentIndex } : { disposition: 'out_of_plan', index: normalizedCurrentIndex };
    }

    const nextScore = scorePlanStep(planSteps[nextIndex]);
    const bestScore = Math.max(currentScore, nextScore);
    if (bestScore < 1.5) {
      return { disposition: 'out_of_plan', index: normalizedCurrentIndex };
    }
    if (nextScore >= 2 && (nextScore >= currentScore + 1.5 || (currentScore < 1 && nextScore >= 3))) {
      return { disposition: 'next', index: nextIndex };
    }
    return { disposition: 'current', index: normalizedCurrentIndex };
  }

  private async inferPlanStepIndexWithModel(args: {
    planSteps: string[];
    currentPlanIndex: number;
    toolName: string;
    toolInput: string;
    thinking: string;
  }): Promise<{ disposition: PlanStepDisposition; index: number }> {
    const { planSteps, currentPlanIndex, toolName, toolInput, thinking } = args;
    const normalizedCurrentIndex = Math.max(0, Math.min(currentPlanIndex, planSteps.length - 1));
    const nextIndex = Math.min(planSteps.length - 1, normalizedCurrentIndex + 1);

    try {
      const decisionText = await this.collectModelText(
        'You classify whether an agent action belongs to the CURRENT plan step, the NEXT plan step, or is OUT_OF_PLAN. Reply with exactly one token: CURRENT, NEXT, or OUT_OF_PLAN.',
        [
          {
            role: 'user',
            content: [
              `Current plan step: ${planSteps[normalizedCurrentIndex]}`,
              `Next plan step: ${planSteps[nextIndex] ?? '(none)'}`,
              `Tool: ${toolName}`,
              `Tool input: ${toolInput}`,
              `Action description: ${thinking}`,
              'If the action introduces work outside these steps, return OUT_OF_PLAN.',
              'Return only CURRENT, NEXT, or OUT_OF_PLAN.',
            ].join('\n'),
          },
        ]
      );

      const normalizedDecision = decisionText.trim().toUpperCase();
      if (normalizedDecision.startsWith('OUT_OF_PLAN')) {
        return { disposition: 'out_of_plan', index: normalizedCurrentIndex };
      }
      if (normalizedDecision.startsWith('NEXT') && nextIndex !== normalizedCurrentIndex) {
        return { disposition: 'next', index: nextIndex };
      }
      if (normalizedDecision.startsWith('CURRENT')) {
        return { disposition: 'current', index: normalizedCurrentIndex };
      }
    } catch (error) {
      console.warn('Plan-step classification fallback triggered:', error);
    }

    return this.inferPlanStepIndex(args);
  }

  // Token usage tracking removed

  /**
   * Process the LLM stream and handle streaming chunks
   */
  private async processLlmStream(
    messages: any[],
    adaptedCallbacks: ExecutionCallbacks
  ): Promise<{ accumulatedText: string, toolCallDetected: boolean }> {
    let accumulatedText = "";
    let streamBuffer = "";
    let toolCallDetected = false;

    // Get tools from the ToolManager
    const tools = this.toolManager.getTools();

    // Use provider interface instead of direct Anthropic API
    const stream = this.llmProvider.createMessage(
      this.promptManager.getSystemPrompt(),
      messages,
      tools
    );

    // Token usage tracking removed

    for await (const chunk of stream) {
      if (this.errorHandler.isExecutionCancelled()) break;

      // Token usage chunks ignored

      // Handle text chunks
      if (chunk.type === 'text' && chunk.text) {
        const textChunk = chunk.text;
        accumulatedText += textChunk;
        streamBuffer += textChunk;

        // Only look for complete tool calls with all three required tags
        const completeToolCallRegex = /(```(?:xml|bash)\s*)?<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires_approval>(.*?)<\/requires_approval>(\s*```)?/;

        // Try to match the complete tool call pattern
        const completeToolCallMatch = streamBuffer.match(completeToolCallRegex);

        // Only process complete tool calls with all three required tags
        if (completeToolCallMatch && !toolCallDetected) {
          toolCallDetected = true;
          console.log("Complete tool call detected:", completeToolCallMatch);

          // Extract the tool call with requires_approval value
          const [fullMatch, codeBlockStart, toolName, toolInput, requiresApprovalRaw] = completeToolCallMatch;

          // Find the start of the tool call
          const matchIndex = codeBlockStart
            ? (streamBuffer.indexOf("```xml") !== -1
               ? streamBuffer.indexOf("```xml")
               : streamBuffer.indexOf("```bash"))
            : streamBuffer.indexOf("<tool>");

          // Get text before the tool call
          const textBeforeToolCall = streamBuffer.substring(0, matchIndex);

          // Finalize the current segment
          if (textBeforeToolCall.trim() && adaptedCallbacks.onSegmentComplete) {
            adaptedCallbacks.onSegmentComplete(textBeforeToolCall);
          }

          // Clear the buffer
          streamBuffer = "";

          // Don't send any more chunks until tool execution is complete
          break;
        }

        // If no tool call detected yet, continue sending chunks
        if (!toolCallDetected && adaptedCallbacks.onLlmChunk) {
          adaptedCallbacks.onLlmChunk(textChunk);
        }
      }
    }

    // After streaming completes, process the full response
    console.log("Streaming completed. Accumulated text length:", accumulatedText.length);

    // Decode any escaped HTML entities in the accumulated text
    accumulatedText = this.decodeHtmlEntities(accumulatedText);
    console.log("Decoded HTML entities in accumulated text");

    adaptedCallbacks.onLlmOutput(accumulatedText);

    return { accumulatedText, toolCallDetected };
  }

  /**
   * Execute prompt with support for both streaming and non-streaming modes
   */
  async executePrompt(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = [],
    isStreaming: boolean
  ): Promise<void> {
    // Create adapter to handle streaming vs non-streaming
    const adapter = new CallbackAdapter(callbacks, isStreaming);
    const adaptedCallbacks = adapter.adaptedCallbacks;

      // Reset cancel flag at the start of execution
      this.errorHandler.resetCancel();
      this.adaptiveGateState = { ...INITIAL_ADAPTIVE_GATE_STATE };
      this.resetApprovedPlanState();
      this.executedPlanEvidence = [];
      try {
      // Initialize messages with the prompt
      this.currentTaskPrompt = prompt;
      let messages = this.initializeMessages(prompt, initialMessages);
      this.liveMessages = messages;
      this.promptManager.setApprovedPlanGuidance('');

      let done = false;
      let terminalStatus: ExecutionTerminalStatus | null = null;
      let terminalReason: string | undefined;
      let step = 0;
      let planReviewed = false;

      if (!planReviewed && adaptedCallbacks.onPlanReviewRequired) {
        const generatedPlan = await this.generateTaskPlan(prompt, messages);
        adaptedCallbacks.onPlanGenerated?.({
          summary: generatedPlan.summary,
          steps: generatedPlan.steps,
        });
        const planReview = await adaptedCallbacks.onPlanReviewRequired({
          stepId: `plan_${Date.now()}`,
          toolName: 'planning',
          toolInput: prompt,
          planSummary: generatedPlan.summary,
          plan: generatedPlan.steps,
        });
        planReviewed = true;

        if (planReview.decision === 'reject') {
          adaptedCallbacks.onToolOutput('❌ Plan review rejected. Execution terminated before tool execution.');
          messages.push({ role: 'user', content: 'Plan review rejected by user. Do not execute further actions.' });
          terminalStatus = 'stopped';
          terminalReason = 'Plan review rejected by user.';
          done = true;
        } else if (planReview.decision === 'edit') {
          const editText = planReview.editedPlan?.trim() || 'Plan edited by user.';
          this.promptManager.setApprovedPlanGuidance(editText);
          this.applyApprovedPlanText(editText);
          if (this.approvedPlanState && !/^\s*plan summary:/im.test(editText)) {
            this.setApprovedPlanState({
              summary: generatedPlan.summary,
              steps: this.approvedPlanState.steps,
            });
          }
          adaptedCallbacks.onToolOutput(`✏️ Plan edited by user. Applying guidance: ${editText}`);
          this.rewriteLiveMessagesForApprovedPlan(editText);
          messages = this.liveMessages ?? messages;
        } else {
          const approvedPlanText = [
            `Plan Summary: ${generatedPlan.summary}`,
            ...generatedPlan.steps.map((step, index) => `Step ${index + 1}: ${step}`),
          ].join('\n');
          this.setApprovedPlanState(generatedPlan);
          this.promptManager.setApprovedPlanGuidance(approvedPlanText);
          this.rewriteLiveMessagesForApprovedPlan(approvedPlanText);
          messages = this.liveMessages ?? messages;
        }
      } else if (adaptedCallbacks.onPlanStepApprovalRequired) {
        const generatedPlan = await this.generateTaskPlan(prompt, messages);
        adaptedCallbacks.onPlanGenerated?.({
          summary: generatedPlan.summary,
          steps: generatedPlan.steps,
        });
        this.setApprovedPlanState(generatedPlan);
        const approvedPlanText = [
          `Plan Summary: ${generatedPlan.summary}`,
          ...generatedPlan.steps.map((stepText, index) => `Step ${index + 1}: ${stepText}`),
        ].join('\n');
        this.promptManager.setApprovedPlanGuidance(approvedPlanText);
        this.rewriteLiveMessagesForApprovedPlan(approvedPlanText);
        messages = this.liveMessages ?? messages;
      }

      while (!done && step++ < MAX_STEPS && !this.errorHandler.isExecutionCancelled()) {
        try {
          if (adaptedCallbacks.onPrepareModelStep) {
            const context = await adaptedCallbacks.onPrepareModelStep();
            this.promptManager.setAmplificationContext({
              state: context.amplificationState,
              enteredReason: context.enteredReason,
            });
          } else {
            this.promptManager.setAmplificationContext({ state: 'normal' });
          }

          // Check for cancellation before each major step
          if (this.errorHandler.isExecutionCancelled()) break;

          // ── 1. Call LLM with streaming ───────────────────────────────────────
          const { accumulatedText } = await this.processLlmStream(messages, adaptedCallbacks);

          // Check for cancellation after LLM response
          if (this.errorHandler.isExecutionCancelled()) break;

          // Check for incomplete or malformed tool calls
          // This regex looks for tool calls that have <tool> and <input> but are missing <requires_approval>
          const incompleteApprovalRegex = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>(?!\s*<requires_approval>)/;
          const incompleteApprovalMatch = accumulatedText.match(incompleteApprovalRegex);

          // Check for interrupted tool calls (has input tag but interrupted during requires_approval)
          const interruptedToolRegex = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires(_approval)?$/;
          const interruptedToolMatch = accumulatedText.match(interruptedToolRegex);

          // Handle incomplete tool calls with missing requires_approval tag
          if (incompleteApprovalMatch && !accumulatedText.includes("<requires_approval>")) {
            const toolName = incompleteApprovalMatch[1].trim();
            const toolInput = incompleteApprovalMatch[2].trim();

            console.log("Detected incomplete tool call missing requires_approval tag:", incompleteApprovalMatch[0]);

            // Add a message to prompt the LLM to use the complete format
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call format. You provided <tool>${toolName}</tool> and <input>${toolInput}</input> but no <requires_approval> tag. Please use the complete format with all three required tags:

<tool>tool_name</tool>
<input>arguments here</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }
          // Handle interrupted tool calls
          else if (interruptedToolMatch &&
              !interruptedToolMatch[0].includes("</requires_approval>") &&
              (interruptedToolMatch[0].endsWith("<requires") ||
               interruptedToolMatch[0].endsWith("<requires_approval"))) {

            const toolName = interruptedToolMatch[1].trim();
            const toolInput = interruptedToolMatch[2].trim();

            console.log("Detected interrupted tool call with partial requires_approval tag:", interruptedToolMatch[0]);

            // Instead of assuming approval, ask the LLM to complete the tool call properly
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Your tool call was interrupted. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>${toolInput}</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }

          // ── 2. Parse for tool invocation ─────────────────────────────────────
          // Only look for complete tool calls with all three required tags
          const toolMatch = accumulatedText.match(
            /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires_approval>(.*?)<\/requires_approval>/
          );

          // Check for various types of incomplete tool calls
          // 1. Tool tag without input tag
          const missingInputMatch = accumulatedText.match(/<tool>(.*?)<\/tool>(?!\s*<input>)/);
          // 2. Tool and input tags without requires_approval tag
          const missingApprovalMatch = accumulatedText.match(/<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>(?!\s*<requires_approval>)/);

          if (missingInputMatch !== null && toolMatch === null) {
            // Handle tool call missing input tag
            const toolName = missingInputMatch[1].trim();
            adaptedCallbacks.onToolOutput(`⚠️ Incomplete tool call detected: ${toolName} (missing input and requires_approval tags)`);

            // Add a message to prompt the LLM to complete the tool call with all required tags
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call. You provided <tool>${toolName}</tool> but are missing the <input> and <requires_approval> tags. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>arguments here</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          } else if (missingApprovalMatch !== null && toolMatch === null) {
            // Handle tool call missing requires_approval tag
            const toolName = missingApprovalMatch[1].trim();
            const toolInput = missingApprovalMatch[2].trim();
            adaptedCallbacks.onToolOutput(`⚠️ Incomplete tool call detected: ${toolName} (missing requires_approval tag)`);

            // Add a message to prompt the LLM to complete the tool call with all required tags
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call. You provided <tool>${toolName}</tool> and <input>${toolInput}</input> but are missing the <requires_approval> tag. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>${toolInput}</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }

          if (!toolMatch) {
            const completion = this.parseTaskCompletion(accumulatedText);
            if (completion.complete) {
              const pendingPlanReason = this.getPendingPlanCompletionReason();
              if (pendingPlanReason) {
                messages.push(
                  { role: 'assistant', content: accumulatedText },
                  {
                    role: 'user',
                    content:
                      `Completion rejected because the approved plan is not finished yet. ${pendingPlanReason}\n` +
                      'Do not output <task_status>complete</task_status> yet. Continue with the next observation or action needed to finish the remaining approved plan steps.',
                  }
                );
                messages = trimHistory(messages);
                this.liveMessages = messages;
                continue;
              }

              const completionAssessment = await this.assessApprovedPlanCompletion();
              if (!completionAssessment.allowed) {
                messages.push(
                  { role: 'assistant', content: accumulatedText },
                  {
                    role: 'user',
                    content:
                      `Completion rejected because the approved plan still lacks sufficient execution evidence. ${completionAssessment.reason || ''}\n` +
                      'Do not output <task_status>complete</task_status> yet. Continue with the next observation or action needed to finish and verify the remaining approved plan steps.',
                  }
                );
                messages = trimHistory(messages);
                this.liveMessages = messages;
                continue;
              }

            if (completion.finalResponse) {
              adaptedCallbacks.onLlmOutput(completion.finalResponse);
            } else {
              adaptedCallbacks.onLlmOutput('Task completed.');
            }
            terminalStatus = 'completed';
            done = true;
            break;
          }

          adaptedCallbacks.onToolOutput('⚠️ Model stopped after reasoning without a valid tool call. Requesting a corrected XML tool call.');
          messages.push(
            { role: 'assistant', content: accumulatedText },
            {
                role: 'user',
                content:
                  'You stopped without a valid tool call or completion marker. ' +
                  'Do not end with plain-text summary alone. ' +
                  'If the task is fully completed and verified on the page, respond with ' +
                  '<task_status>complete</task_status> and <final_response>...</final_response>. ' +
                  'Otherwise continue with the next observation or action using the required tool-call XML.',
              }
            );
            messages = trimHistory(messages);
            this.liveMessages = messages;
            continue;
          }

          // Extract tool information from the complete tool call
          let toolName, toolInput, llmRequiresApproval;

          if (toolMatch) {
            const [, toolNameRaw, toolInputRaw, requiresApprovalRaw] = toolMatch;
            toolName = toolNameRaw.trim();
            toolInput = toolInputRaw.trim();
            llmRequiresApproval = requiresApprovalRaw.trim().toLowerCase() === 'true';
          } else {
            messages.push(
              { role: 'assistant', content: accumulatedText },
              {
                role: 'user',
                content:
                  'No valid tool call was found. Either emit a complete tool call with all required tags, ' +
                  'or explicitly mark verified completion with <task_status>complete</task_status> ' +
                  'and <final_response>...</final_response>.',
              }
            );
            messages = trimHistory(messages);
            this.liveMessages = messages;
            continue;
          }
          const tool = this.toolManager.findTool(toolName);
          const stepId = createStepId(step);
          const modelMetadata = this.parseModelStepMetadata(accumulatedText);
          const amplificationState = this.promptManager.getAmplificationState();
          if (amplificationState === 'amplified') {
            if (!this.hasRequiredAmplifiedScaffold(accumulatedText)) {
              messages.push(
                { role: 'assistant', content: accumulatedText },
                {
                  role: 'user',
                  content:
                    'Amplified mode schema violation. Before the tool call, include:\n' +
                    'Next Step I Plan To Do:\nAlternative:\nWhy I choose A over B:',
                }
              );
              messages = trimHistory(messages);
              this.liveMessages = messages;
              continue;
            }
          }
          const thinking = buildThinkingSummary({
            goal: prompt,
            toolName,
            toolInput,
            accumulatedText,
            modelThinkingSummary: modelMetadata.thinkingSummary,
          });

          emitAgentThinking(stepId, toolName, thinking);

          const baseRiskAssessment = inferRiskAssessment(toolName, toolInput);
          const resolvedImpact = modelMetadata.impact ?? baseRiskAssessment.impact;
          const impactSource: 'llm' | 'heuristic' = modelMetadata.impact ? 'llm' : 'heuristic';
          const riskAssessment = {
            ...baseRiskAssessment,
            impact: resolvedImpact,
            gold_risky: resolvedImpact === 'high' ? true : baseRiskAssessment.gold_risky,
            reasons: modelMetadata.impact
              ? [
                  `LLM assessed impact as ${modelMetadata.impact}.`,
                  ...(modelMetadata.impactRationale ? [modelMetadata.impactRationale] : []),
                  ...baseRiskAssessment.reasons,
                ]
              : baseRiskAssessment.reasons,
          };
          const gateConfig = await this.getInterventionGateConfig();
          const amplifiedRisk = adaptedCallbacks.classifyAmplifiedRisk
            ? adaptedCallbacks.classifyAmplifiedRisk({ toolName, toolInput })
            : null;
          const promptedByGate =
            gateConfig.enabled &&
            shouldPromptByGatePolicy(gateConfig.policy, riskAssessment, this.adaptiveGateState.currentLevel);
          this.adaptiveGateState = updateAdaptiveStateFromStep(this.adaptiveGateState, riskAssessment, promptedByGate);

          const llmReason = llmRequiresApproval
            ? "The AI assistant has determined this action requires your approval."
            : null;
          const gateReason = promptedByGate
            ? `Intervention Gate (${gateConfig.policy}) blocked this step because impact is ${riskAssessment.impact}.`
            : null;
          const reasonParts = [llmReason, gateReason, ...riskAssessment.reasons].filter(Boolean) as string[];

          let requiresApproval = llmRequiresApproval || promptedByGate;
          let postActionReviewRequired = false;

          if (gateConfig.controlMode === 'step_through') {
            requiresApproval = true;
            reasonParts.push('Control mode step_through requires approval on each step.');
          } else if (gateConfig.controlMode === 'approve_all') {
            requiresApproval = false;
            reasonParts.push('Control mode approve_all auto-approves this step.');
          }

          if (gateConfig.timingPolicy === 'pre_navigation' && requiresApproval && !toolName.includes('navigate')) {
            requiresApproval = false;
            reasonParts.push('Timing policy pre_navigation only prompts before navigation tools.');
          }
          if (gateConfig.timingPolicy === 'post_action' && requiresApproval) {
            postActionReviewRequired = true;
            requiresApproval = false;
            reasonParts.push('Timing policy post_action requires review after execution.');
          }

          // Supervisory co-execution gates at the plan-step level, not per action.
          if (adaptedCallbacks.onPlanStepApprovalRequired) {
            requiresApproval = false;
            postActionReviewRequired = false;
          }

          const reason = reasonParts.length > 0 ? reasonParts.join(' ') : 'Policy requires approval before execution.';

          if (!tool) {
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: tool "${toolName}" not found. Available: ${this.toolManager.getTools()
                  .map((t) => t.name)
                  .join(", ")}`,
              }
            );
            continue;
          }

          // Check for cancellation before tool execution
          if (this.errorHandler.isExecutionCancelled()) break;

          if (adaptedCallbacks.onWaitForExecutionPermission) {
            const permission = await adaptedCallbacks.onWaitForExecutionPermission();
            if (!permission.allowed) {
              adaptedCallbacks.onToolOutput(`⏸️ Execution blocked: ${permission.reason || 'runtime policy block'}`);
              terminalStatus = 'stopped';
              terminalReason = permission.reason || 'Execution blocked by runtime policy.';
              done = true;
              messages.push(
                { role: "assistant", content: accumulatedText },
                { role: "user", content: `Execution blocked by runtime state. ${permission.reason || ''}` }
              );
              messages = trimHistory(messages);
              this.liveMessages = messages;
              continue;
            }
          }

          if (adaptedCallbacks.onBeforeToolInvocation) {
            const softWindow = await adaptedCallbacks.onBeforeToolInvocation({ stepId, toolName });
            if (!softWindow.allowed) {
              adaptedCallbacks.onToolOutput(`⏸️ Action paused: ${softWindow.reason || 'soft deliberation window'}`);
              messages.push(
                { role: 'assistant', content: accumulatedText },
                { role: 'user', content: `Action paused before execution. ${softWindow.reason || ''}` }
              );
              messages = trimHistory(messages);
              this.liveMessages = messages;
              continue;
            }
          }

          let resolvedPlanStepIndex = this.currentPlanStepIndex;
          const stepDescription =
            modelMetadata.thinkingSummary ||
            thinking.rationale ||
            thinking.goal ||
            '';
          if (this.approvedPlanState?.steps.length) {
            const planMatch = await this.inferPlanStepIndexWithModel({
              planSteps: this.approvedPlanState.steps,
              currentPlanIndex: this.currentPlanStepIndex,
              toolName,
              toolInput,
              thinking: stepDescription,
            });
            if (planMatch.disposition === 'out_of_plan') {
              const currentStepText = this.approvedPlanState.steps[this.currentPlanStepIndex] || '(unknown current step)';
              const nextStepText =
                this.approvedPlanState.steps[Math.min(this.approvedPlanState.steps.length - 1, this.currentPlanStepIndex + 1)] ||
                '(no next step)';
              adaptedCallbacks.onToolOutput('❌ Planned action rejected: the proposed tool call is outside the approved plan.');
              messages.push(
                { role: 'assistant', content: accumulatedText },
                {
                  role: 'user',
                  content:
                    `Stop. Your proposed action is outside the approved plan.\n` +
                    `Current approved step: ${currentStepText}\n` +
                    `Next approved step: ${nextStepText}\n` +
                    `Do not execute actions outside the approved plan. Wait for a plan update or propose an action that strictly completes the current or next approved step.`,
                }
              );
              messages = trimHistory(messages);
              this.liveMessages = messages;
              terminalStatus = 'stopped';
              terminalReason = 'Proposed action was outside the approved plan.';
              done = true;
              continue;
            }

            this.currentPlanStepIndex = planMatch.index;
            resolvedPlanStepIndex = planMatch.index;

            if (planMatch.index > 0 && planMatch.index > this.lastCompletionCheckPlanStepIndex) {
              const completedSteps = this.approvedPlanState.steps
                .slice(0, planMatch.index)
                .map((stepText, index) => `${index + 1}. ${stepText}`)
                .join('\n');
              messages.push({
                role: 'user',
                content:
                  `Before starting plan step ${planMatch.index + 1}, first verify that these earlier plan steps are already completed on the page and do not repeat them unless the page clearly shows they still need work:\n` +
                  completedSteps,
              });
              messages = trimHistory(messages);
              this.liveMessages = messages;
              this.lastCompletionCheckPlanStepIndex = planMatch.index;
            }

            if (
              adaptedCallbacks.onPlanStepApprovalRequired &&
              planMatch.index > this.highestAcceptedPlanStepIndex
            ) {
              const planStepApproval = await adaptedCallbacks.onPlanStepApprovalRequired({
                stepId,
                planStepIndex: planMatch.index,
                planStepText: this.approvedPlanState.steps[planMatch.index],
                thinking: stepDescription,
                toolName,
                toolInput,
              });
              if (planStepApproval.decision === 'reject') {
                adaptedCallbacks.onToolOutput('❌ Plan step rejected by user. Execution stopped.');
                messages.push(
                  { role: 'assistant', content: accumulatedText },
                  { role: 'user', content: `The user rejected plan step ${planMatch.index + 1}. Stop execution.` }
                );
                messages = trimHistory(messages);
                this.liveMessages = messages;
                terminalStatus = 'stopped';
                terminalReason = `Plan step ${planMatch.index + 1} rejected by user.`;
                done = true;
                continue;
              }
              this.highestAcceptedPlanStepIndex = planMatch.index;
            }
          }

          if (adaptedCallbacks.onToolStart) {
            adaptedCallbacks.onToolStart(
              stepId,
              toolName,
              toolInput,
              this.approvedPlanState?.steps.length ? resolvedPlanStepIndex : undefined,
              stepDescription
            );
          }
          if (adaptedCallbacks.onAfterToolStart) {
            await adaptedCallbacks.onAfterToolStart({
              stepId,
              toolName,
              toolInput,
              thinking: stepDescription,
            });
          }

          // ── 3. Execute tool ──────────────────────────────────────────────────
          adaptedCallbacks.onToolOutput(`🕹️ tool: ${toolName} | args: ${toolInput}`);

          let result: string;
          let haltAfterReviewDeny = false;

          if (adaptedCallbacks.onRiskSignal) {
            adaptedCallbacks.onRiskSignal(stepId, toolName, {
              signal: requiresApproval ? 'approval_required' : 'risk_assessed',
              requiresApproval,
              postActionReviewRequired,
              llmRequiresApproval,
              promptedByGate,
              gatePolicy: gateConfig.policy,
              controlMode: gateConfig.controlMode,
              timingPolicy: gateConfig.timingPolicy,
              adaptiveGateLevel: this.adaptiveGateState.currentLevel,
              impact: riskAssessment.impact,
              impactSource,
              impactRationale: modelMetadata.impactRationale,
              gold_risky: riskAssessment.gold_risky,
              reversible: riskAssessment.reversible,
              category: riskAssessment.category,
              reasons: riskAssessment.reasons,
              reason,
              plannedNextStep: modelMetadata.plannedNextStep,
              plannedAlternative: modelMetadata.plannedAlternative,
              plannedRationale: modelMetadata.plannedRationale,
              amplifiedRisk,
            });
          }

          if (requiresApproval) {
            // Notify the user that approval is required
            adaptedCallbacks.onToolOutput(`⚠️ This action requires approval: ${reason}`);

            // Get the current tab ID from chrome.tabs API
            const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const tabId = tabs[0]?.id || 0;

            try {
              // Request approval from the user
              const approved = await requestApproval(tabId, stepId, toolName, toolInput, reason);

              if (approved) {
                this.adaptiveGateState = updateAdaptiveStateFromDecision(this.adaptiveGateState, 'approve');
                // User approved, execute the tool
                adaptedCallbacks.onToolOutput(`✅ Action approved by user. Executing...`);

                // Create a context object to pass to the tool
                const context = {
                  requiresApproval: true,
                  approvalReason: reason
                };

                // Execute the tool with the context
                try {
                  result = await tool.func(toolInput, context);
                } catch (toolError) {
                  if (adaptedCallbacks.onToolError) {
                    adaptedCallbacks.onToolError(
                      stepId,
                      toolName,
                      toolInput,
                      toolError instanceof Error ? toolError.message : String(toolError)
                    );
                  }
                  throw toolError;
                }
              } else {
                this.adaptiveGateState = updateAdaptiveStateFromDecision(this.adaptiveGateState, 'deny');
                // User rejected, skip execution
                result = "Action cancelled by user.";
                adaptedCallbacks.onToolOutput(`❌ Action rejected by user.`);
              }
            } catch (approvalError) {
              console.error(`Error in approval process:`, approvalError);
              if (adaptedCallbacks.onToolError) {
                adaptedCallbacks.onToolError(
                  stepId,
                  toolName,
                  toolInput,
                  approvalError instanceof Error ? approvalError.message : String(approvalError)
                );
              }
              result = "Error in approval process. Action cancelled.";
              adaptedCallbacks.onToolOutput(`❌ Error in approval process: ${approvalError}`);
            }
          } else {
            // No approval required, execute the tool normally
            try {
              result = await tool.func(toolInput);
            } catch (toolError) {
              if (adaptedCallbacks.onToolError) {
                adaptedCallbacks.onToolError(
                  stepId,
                  toolName,
                  toolInput,
                  toolError instanceof Error ? toolError.message : String(toolError)
                );
              }
              throw toolError;
            }
          }

          if (postActionReviewRequired) {
            adaptedCallbacks.onToolOutput(`⚠️ Post-action review required for: ${toolName}`);
            try {
              const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              const tabId = tabs[0]?.id || 0;
              const reviewReason = `${reason} Post-action review: confirm whether to continue with subsequent steps.`;
              const approved = await requestApproval(tabId, stepId, toolName, toolInput, reviewReason);
              if (approved) {
                this.adaptiveGateState = updateAdaptiveStateFromDecision(this.adaptiveGateState, 'approve');
                adaptedCallbacks.onToolOutput('✅ Post-action review approved.');
              } else {
                this.adaptiveGateState = updateAdaptiveStateFromDecision(this.adaptiveGateState, 'deny');
                adaptedCallbacks.onToolOutput('❌ Post-action review denied. Follow-up actions halted by policy.');
                result = `${result}\nPost-action review denied by user.`;
                haltAfterReviewDeny = true;
              }
              if (adaptedCallbacks.onRiskSignal) {
                adaptedCallbacks.onRiskSignal(stepId, toolName, {
                  signal: 'post_action_review',
                  reviewed: true,
                  approved,
                  reason: reviewReason,
                });
              }
            } catch (reviewError) {
              adaptedCallbacks.onToolOutput(
                `❌ Post-action review failed: ${reviewError instanceof Error ? reviewError.message : String(reviewError)}`
              );
              result = `${result}\nPost-action review failed.`;
            }
          }

          // Signal that tool execution is complete
          if (adaptedCallbacks.onToolEnd) {
            adaptedCallbacks.onToolEnd(stepId, result);
          }
          if (adaptedCallbacks.onAfterToolCommitted) {
            await adaptedCallbacks.onAfterToolCommitted();
          }

          if (this.approvedPlanState?.steps.length && typeof resolvedPlanStepIndex === 'number') {
            this.executedPlanEvidence.push({
              planStepIndex: Math.max(0, Math.min(resolvedPlanStepIndex, this.approvedPlanState.steps.length - 1)),
              toolName,
              toolInput,
              thinking: stepDescription,
              status:
                haltAfterReviewDeny || result.includes('Action cancelled by user.')
                  ? 'cancelled'
                  : 'completed',
            });
          }

          // Check for cancellation after tool execution
          if (this.errorHandler.isExecutionCancelled()) break;

          if (haltAfterReviewDeny) {
            terminalStatus = 'stopped';
            terminalReason = 'Execution stopped by post-action review policy.';
            done = true;
            messages.push(
              { role: "assistant", content: accumulatedText },
              { role: "user", content: `Tool result: ${result}\nExecution stopped by post-action review policy.` }
            );
            messages = trimHistory(messages);
            this.liveMessages = messages;
            continue;
          }

          // ── 4. Record turn & prune history ───────────────────────────────────
          messages.push(
            { role: "assistant", content: accumulatedText }
          );

          // Add the tool result to the message history
          try {
            // Try to parse the result as JSON to handle special formats
            const parsedResult = JSON.parse(result);

            // Handle screenshot references
            if (parsedResult.type === "screenshotRef" && parsedResult.id) {
              // Create a message for the LLM with the screenshot reference
              // The actual screenshot display is handled by agentController.ts
              messages.push({
                role: "user",
                content: `Tool result: Screenshot captured (${parsedResult.id}). ${parsedResult.note || ''} Based on this image, please answer the user's original question: "${prompt}". Don't just describe the image - focus on answering the specific question or completing the task the user asked for.`
              });
            } else {
              // For other JSON results, stringify them nicely
              messages.push({
                role: "user",
                content: `Tool result: ${JSON.stringify(parsedResult, null, 2)}`
              });
            }
          } catch (error) {
            // If not valid JSON, add as plain text
            messages.push({ role: "user", content: `Tool result: ${result}` });
          }

          messages = trimHistory(messages);
          this.liveMessages = messages;
        } catch (error) {
          // If an error occurs during execution, check if it was due to cancellation
          if (this.errorHandler.isExecutionCancelled()) break;
          throw error; // Re-throw if it wasn't a cancellation
        }
      }

      if (this.errorHandler.isExecutionCancelled()) {
        terminalStatus = 'cancelled';
        terminalReason = 'Execution cancelled by user.';
        adaptedCallbacks.onLlmOutput(
          `\n\nExecution cancelled by user.`
        );
      } else if (step >= MAX_STEPS) {
        terminalStatus = 'max_steps';
        terminalReason = `Exceeded maximum of ${MAX_STEPS} steps.`;
        adaptedCallbacks.onLlmOutput(
          `Stopped: exceeded maximum of ${MAX_STEPS} steps.`
        );
      } else if (!terminalStatus) {
        terminalStatus = 'stopped';
      }
      this.liveMessages = null;
      this.currentTaskPrompt = '';
      adaptedCallbacks.onComplete({ status: terminalStatus, reason: terminalReason });
    } catch (err: any) {
      this.liveMessages = null;
      this.currentTaskPrompt = '';
      // Check if this is a retryable error (rate limit or overloaded)
      if (this.errorHandler.isRetryableError(err)) {
        console.log("Retryable error detected:", err);
        // For retryable errors, notify but don't complete processing
        // This allows the fallback mechanism to retry while maintaining UI state
        if (adaptedCallbacks.onError) {
          adaptedCallbacks.onError(err);
        } else {
          adaptedCallbacks.onLlmOutput(this.errorHandler.formatErrorMessage(err));
        }

        // Notify about fallback before re-throwing
        if (adaptedCallbacks.onFallbackStarted) {
          adaptedCallbacks.onFallbackStarted();
        }

        // Get retry attempt from error if available, or default to 0
        const retryAttempt = (err as any).retryAttempt || 0;

        // Maximum number of retry attempts
        const MAX_RETRY_ATTEMPTS = 5;

        if (retryAttempt < MAX_RETRY_ATTEMPTS && !isStreaming) {
          // Only retry in non-streaming mode
          // Calculate backoff time using the ErrorHandler
          const backoffTime = this.errorHandler.calculateBackoffTime(err, retryAttempt);

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, backoffTime));

          // Notify that we're retrying
          const errorType = this.errorHandler.isOverloadedError(err) ? 'server overload' : 'rate limit';
          adaptedCallbacks.onToolOutput(`Retrying after ${errorType} error (attempt ${retryAttempt + 1} of ${MAX_RETRY_ATTEMPTS})...`);

          // Increment retry attempt for the next try
          (err as any).retryAttempt = retryAttempt + 1;

          // Recursive retry with the same parameters
          return this.executePrompt(prompt, callbacks, initialMessages, isStreaming);
        } else if (retryAttempt >= MAX_RETRY_ATTEMPTS) {
          // We've exceeded the maximum number of retry attempts
          adaptedCallbacks.onLlmOutput(
            `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded. Please try again later.`
          );
          adaptedCallbacks.onComplete({
            status: 'failed',
            reason: `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded.`,
          });
        } else {
          // In streaming mode, re-throw to trigger fallback
          throw err;
        }
      } else {
        // For other errors, show error message
        adaptedCallbacks.onLlmOutput(
          `Fatal error: ${err instanceof Error ? err.message : String(err)}`
        );

        // In streaming mode, re-throw to trigger fallback WITHOUT completing
        if (isStreaming) {
          throw err;
        } else {
          // Only complete processing if we're not going to fallback
          adaptedCallbacks.onComplete({
            status: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
