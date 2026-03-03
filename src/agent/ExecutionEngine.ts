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
const MAX_OUTPUT_TOKENS = 1024;  // max tokens for LLM response
type LlmImpact = 'low' | 'medium' | 'high';
type ControlMode = 'approve_all' | 'risky_only' | 'step_through';
type TimingPolicy = 'pre_action' | 'pre_navigation' | 'post_action';

/**
 * Callback interface for execution
 */
export interface ExecutionCallbacks {
  onLlmChunk?: (s: string) => void;
  onLlmOutput: (s: string) => void;
  onToolOutput: (s: string) => void;
  onComplete: () => void;
  onError?: (error: any) => void;
  onToolStart?: (stepId: string, toolName: string, toolInput: string) => void;
  onToolEnd?: (stepId: string, result: string) => void;
  onToolError?: (stepId: string, toolName: string, toolInput: string, error: string) => void;
  onRiskSignal?: (stepId: string, toolName: string, payload: Record<string, unknown>) => void;
  onSegmentComplete?: (segment: string) => void;
  onFallbackStarted?: () => void;
  onPlanReviewRequired?: (payload: {
    stepId: string;
    toolName: string;
    toolInput: string;
    planSummary: string;
    plan?: string[];
  }) => Promise<{ decision: 'approve' | 'edit' | 'reject'; editedPlan?: string }>;
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
      onToolEnd: this.originalCallbacks.onToolEnd,
      onToolError: this.originalCallbacks.onToolError,
      onRiskSignal: this.originalCallbacks.onRiskSignal,
      onSegmentComplete: this.originalCallbacks.onSegmentComplete,
      onFallbackStarted: this.originalCallbacks.onFallbackStarted,
      onPlanReviewRequired: this.originalCallbacks.onPlanReviewRequired,
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

  private handleComplete(): void {
    // In non-streaming mode, emit the full buffer at completion
    if (!this.isStreaming && this.buffer.length > 0) {
      this.originalCallbacks.onLlmOutput(this.buffer);
      this.buffer = '';
    }

    this.originalCallbacks.onComplete();
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
    try {
      // Initialize messages with the prompt
      let messages = this.initializeMessages(prompt, initialMessages);
      this.promptManager.setApprovedPlanGuidance('');

      let done = false;
      let step = 0;
      let planReviewed = false;

      if (!planReviewed && adaptedCallbacks.onPlanReviewRequired) {
        const generatedPlan = await this.generateTaskPlan(prompt, messages);
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
          done = true;
        } else if (planReview.decision === 'edit') {
          const editText = planReview.editedPlan?.trim() || 'Plan edited by user.';
          this.promptManager.setApprovedPlanGuidance(editText);
          adaptedCallbacks.onToolOutput(`✏️ Plan edited by user. Applying guidance: ${editText}`);
          messages.push({
            role: 'user',
            content: `Follow this approved plan guidance for the full task:\n${editText}`,
          });
          messages = trimHistory(messages);
        } else {
          const approvedPlanText = [
            `Plan Summary: ${generatedPlan.summary}`,
            ...generatedPlan.steps.map((step, index) => `Step ${index + 1}: ${step}`),
          ].join('\n');
          this.promptManager.setApprovedPlanGuidance(approvedPlanText);
          messages.push({
            role: 'user',
            content:
              `Plan approved. Follow this plan throughout the task unless new observations require explicit correction:\n` +
              approvedPlanText,
          });
          messages = trimHistory(messages);
        }
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
            // no tool tag ⇒ task complete
            done = true;
            break;
          }

          // Extract tool information from the complete tool call
          let toolName, toolInput, llmRequiresApproval;

          if (toolMatch) {
            const [, toolNameRaw, toolInputRaw, requiresApprovalRaw] = toolMatch;
            toolName = toolNameRaw.trim();
            toolInput = toolInputRaw.trim();
            llmRequiresApproval = requiresApprovalRaw.trim().toLowerCase() === 'true';
          } else {
            // No valid tool call found, task is complete
            done = true;
            break;
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
              done = true;
              messages.push(
                { role: "assistant", content: accumulatedText },
                { role: "user", content: `Execution blocked by runtime state. ${permission.reason || ''}` }
              );
              messages = trimHistory(messages);
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
              continue;
            }
          }

          if (adaptedCallbacks.onToolStart) {
            adaptedCallbacks.onToolStart(stepId, toolName, toolInput);
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

          // Check for cancellation after tool execution
          if (this.errorHandler.isExecutionCancelled()) break;

          if (haltAfterReviewDeny) {
            done = true;
            messages.push(
              { role: "assistant", content: accumulatedText },
              { role: "user", content: `Tool result: ${result}\nExecution stopped by post-action review policy.` }
            );
            messages = trimHistory(messages);
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
        } catch (error) {
          // If an error occurs during execution, check if it was due to cancellation
          if (this.errorHandler.isExecutionCancelled()) break;
          throw error; // Re-throw if it wasn't a cancellation
        }
      }

      if (this.errorHandler.isExecutionCancelled()) {
        adaptedCallbacks.onLlmOutput(
          `\n\nExecution cancelled by user.`
        );
      } else if (step >= MAX_STEPS) {
        adaptedCallbacks.onLlmOutput(
          `Stopped: exceeded maximum of ${MAX_STEPS} steps.`
        );
      }
      adaptedCallbacks.onComplete();
    } catch (err: any) {
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
          adaptedCallbacks.onComplete();
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
          adaptedCallbacks.onComplete();
        }
      }
    }
  }
}
