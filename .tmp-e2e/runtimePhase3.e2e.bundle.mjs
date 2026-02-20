// src/oversight/session/sessionManager.ts
var ACTIVE_SESSION_STORAGE_KEY = "oversight.telemetry.activeSessionId";
var OversightSessionManager = class {
  activeSessionId = null;
  sessionStartedAt = null;
  sessionEndedAt = null;
  generateSessionId() {
    return `oversight_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  async startSession() {
    const sessionId = this.generateSessionId();
    this.activeSessionId = sessionId;
    this.sessionStartedAt = Date.now();
    this.sessionEndedAt = null;
    await chrome.storage.local.set({ [ACTIVE_SESSION_STORAGE_KEY]: sessionId });
    return sessionId;
  }
  async endSession() {
    this.sessionEndedAt = Date.now();
    this.activeSessionId = null;
    await chrome.storage.local.remove(ACTIVE_SESSION_STORAGE_KEY);
  }
  async getActiveSessionId() {
    if (this.activeSessionId) {
      return this.activeSessionId;
    }
    const result = await chrome.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
    const maybeSessionId = result[ACTIVE_SESSION_STORAGE_KEY];
    if (typeof maybeSessionId === "string" && maybeSessionId.length > 0) {
      this.activeSessionId = maybeSessionId;
      return maybeSessionId;
    }
    return null;
  }
  getSessionLifecycle() {
    return {
      startedAt: this.sessionStartedAt,
      endedAt: this.sessionEndedAt
    };
  }
};
var sessionManagerSingleton = null;
function getOversightSessionManager() {
  if (!sessionManagerSingleton) {
    sessionManagerSingleton = new OversightSessionManager();
  }
  return sessionManagerSingleton;
}

// src/oversight/telemetry/redaction.ts
var DEFAULT_REDACTION_LEVEL = "normal";
var DEFAULT_MAX_TEXT_LENGTH = 320;
var STRICT_MAX_TEXT_LENGTH = 180;
var EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
var PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){1}\d{3}[-.\s]?\d{4}\b/g;
var CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;
function clampArray(values, maxTextLength) {
  if (!values || values.length === 0) return values;
  return values.map((value) => value.length > maxTextLength ? `${value.slice(0, maxTextLength)}...` : value);
}
function redactText(text, maxTextLength) {
  let value = text;
  const redactions = /* @__PURE__ */ new Set();
  if (EMAIL_REGEX.test(value)) {
    value = value.replace(EMAIL_REGEX, "[REDACTED_EMAIL]");
    redactions.add("email");
  }
  EMAIL_REGEX.lastIndex = 0;
  if (PHONE_REGEX.test(value)) {
    value = value.replace(PHONE_REGEX, "[REDACTED_PHONE]");
    redactions.add("phone");
  }
  PHONE_REGEX.lastIndex = 0;
  if (CREDIT_CARD_REGEX.test(value)) {
    value = value.replace(CREDIT_CARD_REGEX, "[REDACTED_CARD]");
    redactions.add("credit_card");
  }
  CREDIT_CARD_REGEX.lastIndex = 0;
  if (value.length > maxTextLength) {
    value = `${value.slice(0, maxTextLength)}...`;
    redactions.add("long_text");
  }
  return { value, redactions: Array.from(redactions) };
}
function resolveConfig(level, maxTextLength) {
  if (level === "strict") {
    return {
      level,
      maxTextLength: Math.max(40, maxTextLength ?? STRICT_MAX_TEXT_LENGTH)
    };
  }
  if (level === "off") {
    return {
      level,
      maxTextLength: Number.MAX_SAFE_INTEGER
    };
  }
  return {
    level: "normal",
    maxTextLength: Math.max(40, maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH)
  };
}
function redactThinking(thinking, level = DEFAULT_REDACTION_LEVEL, maxTextLength) {
  const config = resolveConfig(level, maxTextLength);
  if (config.level === "off") {
    return {
      ...thinking,
      redactionsApplied: thinking.redactionsApplied ?? []
    };
  }
  const redactions = new Set(thinking.redactionsApplied ?? []);
  const redactField = (value) => {
    if (!value) return value;
    const result = redactText(value, config.maxTextLength);
    for (const item of result.redactions) redactions.add(item);
    return result.value;
  };
  return {
    ...thinking,
    goal: redactField(thinking.goal) ?? "",
    plan: clampArray(thinking.plan?.map((item) => redactField(item) ?? item), config.maxTextLength),
    memoryRead: clampArray(thinking.memoryRead?.map((item) => redactField(item) ?? item), config.maxTextLength),
    memoryWrite: clampArray(thinking.memoryWrite?.map((item) => redactField(item) ?? item), config.maxTextLength),
    rationale: redactField(thinking.rationale),
    riskFlags: clampArray(thinking.riskFlags?.map((item) => redactField(item) ?? item), config.maxTextLength),
    redactionsApplied: Array.from(redactions)
  };
}
function enforceThinkingSizeLimit(thinking, maxBytes = 2048) {
  const estimateSize = (value) => JSON.stringify(value).length;
  if (estimateSize(thinking) <= maxBytes) return thinking;
  const next = { ...thinking };
  if (next.rationale && next.rationale.length > 120) {
    next.rationale = `${next.rationale.slice(0, 120)}...`;
  }
  if (next.plan && next.plan.length > 3) {
    next.plan = next.plan.slice(0, 3);
  }
  if (next.memoryRead && next.memoryRead.length > 3) {
    next.memoryRead = next.memoryRead.slice(0, 3);
  }
  if (next.memoryWrite && next.memoryWrite.length > 3) {
    next.memoryWrite = next.memoryWrite.slice(0, 3);
  }
  if (next.riskFlags && next.riskFlags.length > 3) {
    next.riskFlags = next.riskFlags.slice(0, 3);
  }
  if (estimateSize(next) <= maxBytes) return next;
  return {
    goal: next.goal.slice(0, 140),
    rationale: next.rationale ? next.rationale.slice(0, 160) : void 0,
    uncertainty: next.uncertainty,
    redactionsApplied: Array.from(/* @__PURE__ */ new Set([...next.redactionsApplied ?? [], "size_limit"]))
  };
}

// src/oversight/telemetry/logger.ts
var TELEMETRY_STORAGE_KEY = "oversight.telemetry.sessions";
var TELEMETRY_REDACTION_LEVEL_KEY = "telemetry.redactionLevel";
var TELEMETRY_REDACTION_MAX_TEXT_KEY = "telemetry.redactionMaxTextLength";
function normalizeTelemetryStorage(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value;
  const normalized = {};
  for (const [sessionId, events] of Object.entries(record)) {
    if (!Array.isArray(events)) continue;
    normalized[sessionId] = events.filter((event) => {
      if (!event || typeof event !== "object") return false;
      const maybeEvent = event;
      return typeof maybeEvent.sessionId === "string" && typeof maybeEvent.timestamp === "number" && typeof maybeEvent.source === "string" && typeof maybeEvent.eventType === "string" && typeof maybeEvent.payload === "object" && maybeEvent.payload !== null;
    });
  }
  return normalized;
}
var OversightTelemetryLogger = class {
  sessionEvents = /* @__PURE__ */ new Map();
  flushedCounts = /* @__PURE__ */ new Map();
  isInitialized = false;
  flushQueue = Promise.resolve();
  redactionLevel = "normal";
  redactionMaxTextLength = 320;
  async ensureInitialized() {
    if (this.isInitialized) return;
    const [localStored, syncStored] = await Promise.all([
      chrome.storage.local.get(TELEMETRY_STORAGE_KEY),
      chrome.storage.sync.get({
        [TELEMETRY_REDACTION_LEVEL_KEY]: "normal",
        [TELEMETRY_REDACTION_MAX_TEXT_KEY]: 320
      })
    ]);
    const normalized = normalizeTelemetryStorage(localStored[TELEMETRY_STORAGE_KEY]);
    const maybeLevel = syncStored[TELEMETRY_REDACTION_LEVEL_KEY];
    if (maybeLevel === "strict" || maybeLevel === "normal" || maybeLevel === "off") {
      this.redactionLevel = maybeLevel;
    }
    const maybeMaxLength = syncStored[TELEMETRY_REDACTION_MAX_TEXT_KEY];
    if (typeof maybeMaxLength === "number" && Number.isFinite(maybeMaxLength) && maybeMaxLength > 0) {
      this.redactionMaxTextLength = maybeMaxLength;
    }
    for (const [sessionId, events] of Object.entries(normalized)) {
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      const pendingLocal = this.sessionEvents.get(sessionId) ?? [];
      const merged = [...sorted, ...pendingLocal].sort((a, b) => a.timestamp - b.timestamp);
      this.sessionEvents.set(sessionId, merged);
      this.flushedCounts.set(sessionId, sorted.length);
    }
    this.isInitialized = true;
  }
  sanitizeThinkingPayload(event) {
    if (event.eventType !== "agent_thinking") {
      return event;
    }
    const maybeThinking = event.payload?.thinkingSummary;
    if (!maybeThinking || typeof maybeThinking.goal !== "string") {
      return event;
    }
    const redacted = redactThinking(maybeThinking, this.redactionLevel, this.redactionMaxTextLength);
    const bounded = enforceThinkingSizeLimit(redacted);
    return {
      ...event,
      payload: {
        ...event.payload,
        thinkingSummary: bounded
      }
    };
  }
  log(event) {
    if (!this.isInitialized) {
      void this.ensureInitialized();
    }
    const current = this.sessionEvents.get(event.sessionId) ?? [];
    current.push(this.sanitizeThinkingPayload(event));
    current.sort((a, b) => a.timestamp - b.timestamp);
    this.sessionEvents.set(event.sessionId, current);
    this.flushQueue = this.flushQueue.then(async () => {
      await this.flush();
    }).catch((error) => {
      console.warn("Telemetry flush failed:", error);
    });
  }
  async flush() {
    await this.ensureInitialized();
    const stored = await chrome.storage.local.get(TELEMETRY_STORAGE_KEY);
    const mergedStorage = normalizeTelemetryStorage(stored[TELEMETRY_STORAGE_KEY]);
    for (const [sessionId, events] of this.sessionEvents.entries()) {
      const alreadyFlushed = this.flushedCounts.get(sessionId) ?? 0;
      const pending = events.slice(alreadyFlushed);
      if (pending.length === 0) continue;
      const existing = mergedStorage[sessionId] ?? [];
      mergedStorage[sessionId] = existing.concat(pending).sort((a, b) => a.timestamp - b.timestamp);
      this.flushedCounts.set(sessionId, events.length);
      this.sessionEvents.set(sessionId, mergedStorage[sessionId]);
    }
    await chrome.storage.local.set({ [TELEMETRY_STORAGE_KEY]: mergedStorage });
  }
  getSessionEvents(sessionId) {
    return [...this.sessionEvents.get(sessionId) ?? []].sort((a, b) => a.timestamp - b.timestamp);
  }
  getSessionEventsByStepId(sessionId, stepId) {
    return this.getSessionEvents(sessionId).filter((event) => event.payload?.stepId === stepId);
  }
  async exportSessionLog(sessionId) {
    await this.flush();
    const events = this.getSessionEvents(sessionId);
    const groupedByStepId = {};
    for (const event of events) {
      const stepId = typeof event.payload?.stepId === "string" ? event.payload.stepId : "";
      if (!stepId) continue;
      groupedByStepId[stepId] = groupedByStepId[stepId] ?? [];
      groupedByStepId[stepId].push(event);
    }
    const oversightRhythmMetrics = this.computeOversightRhythmMetrics(events);
    return JSON.stringify(
      {
        sessionId,
        exportedAt: Date.now(),
        events: events.map((event) => ({
          sessionId: event.sessionId,
          stepId: typeof event.payload?.stepId === "string" ? event.payload.stepId : void 0,
          timestamp: event.timestamp,
          eventType: event.eventType,
          thinkingSummary: event.payload?.thinkingSummary,
          mechanismState: event.payload?.mechanismState,
          humanInteraction: event.source === "human" ? event.payload : void 0,
          source: event.source,
          payload: event.payload
        })),
        groupedByStepId,
        oversightRhythmMetrics
      },
      null,
      2
    );
  }
  computeOversightRhythmMetrics(events) {
    const interruptionEvents = events.filter((event) => {
      const kind = event.payload?.kind;
      return kind === "intervention_prompted" || kind === "execution_paused" || kind === "authority_takeover";
    }).sort((a, b) => a.timestamp - b.timestamp);
    const intervals = [];
    for (let i = 1; i < interruptionEvents.length; i++) {
      intervals.push(Math.max(0, interruptionEvents[i].timestamp - interruptionEvents[i - 1].timestamp));
    }
    const enforcedInterruptions = events.filter((event) => event.payload?.kind === "intervention_prompted").length;
    const userInitiatedInterruptions = events.filter((event) => {
      if (event.payload?.kind === "authority_takeover") return true;
      return event.payload?.kind === "execution_paused" && event.payload?.by === "user";
    }).length;
    const authorityTransitionCount = events.filter((event) => event.payload?.kind === "authority_transition").length;
    return {
      totalInterruptions: interruptionEvents.length,
      enforcedInterruptions,
      userInitiatedInterruptions,
      meanInterruptionIntervalMs: intervals.length > 0 ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0,
      authorityTransitionCount
    };
  }
};
var loggerSingleton = null;
function getOversightTelemetryLogger() {
  if (!loggerSingleton) {
    loggerSingleton = new OversightTelemetryLogger();
  }
  return loggerSingleton;
}

// src/oversight/runtime/authorityManager.ts
var AuthorityManager = class {
  contexts = /* @__PURE__ */ new Map();
  getContext(runtimeKey) {
    const existing = this.contexts.get(runtimeKey);
    if (existing) return existing;
    const created = {
      authorityState: "agent_autonomous",
      lastTransitionAt: Date.now()
    };
    this.contexts.set(runtimeKey, created);
    return created;
  }
  initialize(runtimeKey, authorityState, reason) {
    const next = {
      authorityState,
      lastTransitionAt: Date.now(),
      transitionReason: reason
    };
    this.contexts.set(runtimeKey, next);
    return next;
  }
  transition(runtimeKey, to, reason) {
    const current = this.getContext(runtimeKey);
    const from = current.authorityState;
    if (from === to) {
      return { changed: false, from, to, context: current };
    }
    const next = {
      authorityState: to,
      lastTransitionAt: Date.now(),
      transitionReason: reason
    };
    this.contexts.set(runtimeKey, next);
    return { changed: true, from, to, context: next };
  }
  clear(runtimeKey) {
    this.contexts.delete(runtimeKey);
  }
};

// src/oversight/runtime/executionStateManager.ts
var ExecutionStateManager = class {
  states = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Map();
  getState(runtimeKey) {
    return this.states.get(runtimeKey) ?? "running";
  }
  setState(runtimeKey, state) {
    const from = this.getState(runtimeKey);
    if (from === state) return { from, to: state, changed: false };
    this.states.set(runtimeKey, state);
    const queued = this.waiters.get(runtimeKey) ?? [];
    this.waiters.delete(runtimeKey);
    for (const notify of queued) notify(state);
    return { from, to: state, changed: true };
  }
  async waitUntilRunnable(runtimeKey) {
    const current = this.getState(runtimeKey);
    if (current === "running" || current === "cancelled" || current === "completed") {
      return current;
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(runtimeKey) ?? [];
      list.push(resolve);
      this.waiters.set(runtimeKey, list);
    });
  }
  clear(runtimeKey) {
    this.waiters.delete(runtimeKey);
    this.states.delete(runtimeKey);
  }
};

// src/oversight/runtime/phaseManager.ts
var PhaseManager = class {
  phases = /* @__PURE__ */ new Map();
  pendingReviews = /* @__PURE__ */ new Map();
  getPhase(runtimeKey) {
    return this.phases.get(runtimeKey) ?? "planning";
  }
  setPhase(runtimeKey, phase) {
    const from = this.getPhase(runtimeKey);
    if (from === phase) return { from, to: phase, changed: false };
    this.phases.set(runtimeKey, phase);
    return { from, to: phase, changed: true };
  }
  requestPlanReview(runtimeKey) {
    this.setPhase(runtimeKey, "plan_review");
    return new Promise((resolve) => {
      this.pendingReviews.set(runtimeKey, {
        resolve,
        createdAt: Date.now()
      });
    });
  }
  resolvePlanReview(runtimeKey, decision, editedPlan) {
    const pending = this.pendingReviews.get(runtimeKey);
    if (!pending) return false;
    this.pendingReviews.delete(runtimeKey);
    pending.resolve({ decision, editedPlan });
    return true;
  }
  hasPendingPlanReview(runtimeKey) {
    return this.pendingReviews.has(runtimeKey);
  }
  clear(runtimeKey) {
    this.pendingReviews.delete(runtimeKey);
    this.phases.delete(runtimeKey);
  }
};

// src/oversight/runtime/runtimeManager.ts
var OversightRuntimeManager = class {
  authorityManager = new AuthorityManager();
  phaseManager = new PhaseManager();
  executionStateManager = new ExecutionStateManager();
  bindings = /* @__PURE__ */ new Map();
  dispatcher = null;
  setDispatcher(dispatcher) {
    this.dispatcher = dispatcher;
  }
  runtimeKey(windowId) {
    return `window:${windowId ?? 0}`;
  }
  async logTelemetry(eventType, payload) {
    const sessionManager = getOversightSessionManager();
    const logger = getOversightTelemetryLogger();
    const sessionId = await sessionManager.getActiveSessionId() ?? await sessionManager.startSession();
    logger.log({
      sessionId,
      timestamp: Date.now(),
      source: "system",
      eventType,
      payload
    });
  }
  notifyRuntimeState(runtimeKey) {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    this.dispatcher.emitRuntimeState(this.getSnapshot(runtimeKey), binding.tabId, binding.windowId);
  }
  async emitAuthorityTransition(runtimeKey, from, to, reason) {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: "authority_transition", from, to, reason, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry("state_transition", {
      kind: "authority_transition",
      from,
      to,
      reason,
      timestamp
    });
  }
  async emitPhaseChanged(runtimeKey, from, to, reason) {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: "execution_phase_changed", from, to, reason, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry("state_transition", {
      kind: "execution_phase_changed",
      from,
      to,
      reason,
      timestamp
    });
  }
  async emitExecutionStateChanged(runtimeKey, from, to, reason, by) {
    const binding = this.bindings.get(runtimeKey);
    if (!binding || !this.dispatcher) return;
    const timestamp = Date.now();
    this.dispatcher.emitOversightEvent(
      { kind: "execution_state_changed", from, to, reason, by, timestamp },
      binding.tabId,
      binding.windowId
    );
    await this.logTelemetry("state_transition", {
      kind: "execution_state_changed",
      from,
      to,
      reason,
      by,
      timestamp
    });
  }
  getSnapshot(runtimeKey) {
    return {
      authorityState: this.authorityManager.getContext(runtimeKey).authorityState,
      executionPhase: this.phaseManager.getPhase(runtimeKey),
      executionState: this.executionStateManager.getState(runtimeKey),
      updatedAt: Date.now()
    };
  }
  initializeRun(args) {
    const key = this.runtimeKey(args.windowId);
    this.bindings.set(key, { tabId: args.tabId, windowId: args.windowId });
    const initialAuthority = args.controlMode === "step_through" || args.gatePolicy === "adaptive" ? "shared_supervision" : "agent_autonomous";
    this.authorityManager.initialize(key, initialAuthority, `initialized_from_control_mode:${args.controlMode}`);
    this.phaseManager.setPhase(key, "planning");
    this.executionStateManager.setState(key, "running");
    void this.logTelemetry("state_transition", {
      kind: "runtime_initialized",
      controlMode: args.controlMode,
      authorityState: initialAuthority,
      executionPhase: "planning",
      executionState: "running",
      timestamp: Date.now()
    });
    this.notifyRuntimeState(key);
  }
  async transitionAuthority(windowId, to, reason) {
    const key = this.runtimeKey(windowId);
    const transition = this.authorityManager.transition(key, to, reason);
    if (transition.changed) {
      await this.emitAuthorityTransition(key, transition.from, transition.to, reason);
      this.notifyRuntimeState(key);
    }
  }
  async setExecutionPhase(windowId, phase, reason) {
    const key = this.runtimeKey(windowId);
    const transition = this.phaseManager.setPhase(key, phase);
    if (transition.changed) {
      await this.emitPhaseChanged(key, transition.from, transition.to, reason);
      this.notifyRuntimeState(key);
    }
  }
  async setExecutionState(windowId, state, reason, by) {
    const key = this.runtimeKey(windowId);
    const transition = this.executionStateManager.setState(key, state);
    if (transition.changed) {
      await this.emitExecutionStateChanged(key, transition.from, transition.to, reason, by);
      this.notifyRuntimeState(key);
    }
  }
  async requestPlanReview(windowId, payload) {
    const key = this.runtimeKey(windowId);
    const binding = this.bindings.get(key);
    await this.setExecutionPhase(windowId, "plan_review", "await_human_plan_review");
    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(
        {
          kind: "plan_review_requested",
          timestamp: Date.now(),
          planSummary: payload.planSummary,
          plan: payload.plan,
          stepId: payload.stepId,
          toolName: payload.toolName,
          toolInput: payload.toolInput
        },
        binding.tabId,
        binding.windowId
      );
      chrome.runtime.sendMessage({
        action: "planReviewRequired",
        content: {
          runtimeKey: key,
          planSummary: payload.planSummary,
          plan: payload.plan,
          stepId: payload.stepId,
          toolName: payload.toolName,
          toolInput: payload.toolInput
        },
        tabId: binding.tabId,
        windowId: binding.windowId
      });
    }
    return this.phaseManager.requestPlanReview(key);
  }
  async submitPlanReviewDecision(args) {
    const key = this.runtimeKey(args.windowId);
    const resolved = this.phaseManager.resolvePlanReview(key, args.decision, args.editedPlan);
    if (!resolved) return false;
    const edited = args.decision === "edit";
    const timestamp = Date.now();
    const binding = this.bindings.get(key);
    if (binding && this.dispatcher) {
      this.dispatcher.emitOversightEvent(
        {
          kind: "plan_review_decision",
          decision: args.decision,
          edited,
          timestamp
        },
        binding.tabId,
        binding.windowId
      );
    }
    await this.logTelemetry("human_intervention", {
      kind: "plan_review_decision",
      decision: args.decision,
      edited,
      timestamp
    });
    if (args.decision === "reject") {
      await this.setExecutionState(args.windowId, "cancelled", "plan_rejected", "user");
      await this.setExecutionPhase(args.windowId, "terminated", "plan_rejected");
    } else {
      await this.setExecutionPhase(args.windowId, "execution", "plan_approved");
    }
    return true;
  }
  async waitUntilExecutable(windowId) {
    const key = this.runtimeKey(windowId);
    while (true) {
      const phase = this.phaseManager.getPhase(key);
      const executionState = this.executionStateManager.getState(key);
      if (phase !== "execution") {
        return { allowed: false, reason: `Execution blocked by phase=${phase}` };
      }
      if (executionState === "cancelled" || executionState === "completed") {
        return { allowed: false, reason: `Execution blocked by state=${executionState}` };
      }
      if (executionState === "running") {
        return { allowed: true };
      }
      const resumedState = await this.executionStateManager.waitUntilRunnable(key);
      if (resumedState === "cancelled" || resumedState === "completed") {
        return { allowed: false, reason: `Execution blocked by state=${resumedState}` };
      }
    }
  }
  async pauseByUser(windowId) {
    await this.setExecutionState(windowId, "paused_by_user", "user_pause", "user");
    await this.transitionAuthority(windowId, "human_control", "user_pause");
    await this.logTelemetry("human_intervention", { kind: "execution_paused", by: "user", timestamp: Date.now() });
  }
  async resumeByUser(windowId) {
    await this.setExecutionState(windowId, "running", "user_resume", "user");
    await this.transitionAuthority(windowId, "shared_supervision", "user_resume");
    await this.logTelemetry("human_intervention", { kind: "execution_resumed", by: "user", timestamp: Date.now() });
  }
  async takeover(windowId) {
    const key = this.runtimeKey(windowId);
    const previous = this.authorityManager.getContext(key).authorityState;
    await this.setExecutionState(windowId, "paused_by_user", "authority_takeover", "user");
    await this.transitionAuthority(windowId, "human_control", "user_takeover");
    await this.logTelemetry("human_intervention", {
      kind: "authority_takeover",
      previous,
      timestamp: Date.now()
    });
  }
  async releaseControl(windowId) {
    await this.transitionAuthority(windowId, "agent_autonomous", "user_release_control");
    await this.setExecutionState(windowId, "running", "user_release_control", "user");
  }
  async resolveEscalation(windowId) {
    await this.transitionAuthority(windowId, "agent_autonomous", "escalation_resolved");
  }
  async handleAdaptiveRiskSignal(args) {
    if (args.gatePolicy !== "adaptive") return;
    if (args.promptedByGate) {
      await this.transitionAuthority(args.windowId, "shared_supervision", "adaptive_escalation_triggered");
      return;
    }
    if (args.impact === "low") {
      await this.transitionAuthority(args.windowId, "agent_autonomous", "adaptive_escalation_resolved");
    }
  }
  async markRunCompleted(windowId) {
    await this.setExecutionState(windowId, "completed", "run_completed", "system");
    await this.setExecutionPhase(windowId, "posthoc_review", "run_completed");
  }
  async markRunCancelled(windowId) {
    await this.setExecutionState(windowId, "cancelled", "run_cancelled", "system");
    await this.setExecutionPhase(windowId, "terminated", "run_cancelled");
  }
  async markRunFailed(windowId) {
    await this.setExecutionState(windowId, "cancelled", "run_failed", "system");
    await this.setExecutionPhase(windowId, "terminated", "run_failed");
  }
  clear(windowId) {
    const key = this.runtimeKey(windowId);
    this.authorityManager.clear(key);
    this.phaseManager.clear(key);
    this.executionStateManager.clear(key);
    this.bindings.delete(key);
  }
};
var runtimeManagerSingleton = null;
function getOversightRuntimeManager() {
  if (!runtimeManagerSingleton) {
    runtimeManagerSingleton = new OversightRuntimeManager();
  }
  return runtimeManagerSingleton;
}

// src/tests/testUtils.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${String(expected)}, Actual: ${String(actual)}`);
  }
}

// src/tests/runtimePhase3.e2e.test.ts
function installChromeMock(initialLocal = {}, initialSync = {}) {
  const localData = { ...initialLocal };
  const syncData = {
    "telemetry.redactionLevel": "normal",
    "telemetry.redactionMaxTextLength": 320,
    ...initialSync
  };
  const runtimeMessages = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          if (Array.isArray(key)) {
            const out = {};
            for (const item of key) out[item] = localData[item];
            return out;
          }
          return { [key]: localData[key] };
        },
        set: async (value) => {
          for (const [k, v] of Object.entries(value)) localData[k] = v;
        },
        remove: async (key) => {
          if (Array.isArray(key)) {
            for (const item of key) delete localData[item];
            return;
          }
          delete localData[key];
        }
      },
      sync: {
        get: async (defaults) => ({ ...defaults, ...syncData }),
        set: async (value) => {
          for (const [k, v] of Object.entries(value)) syncData[k] = v;
        }
      }
    },
    runtime: {
      lastError: void 0,
      sendMessage: (message, callback) => {
        runtimeMessages.push(message);
        if (callback) callback({ success: true });
      }
    },
    __runtimeMessages: runtimeMessages
  };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function testPlanReviewBlocking() {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9101;
  const tabId = 91;
  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: "risky_only",
    gatePolicy: "impact"
  });
  const initial = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(initial.executionPhase, "planning", "Initial phase should be planning");
  const blockedAtPlanning = await runtimeManager.waitUntilExecutable(windowId);
  assert(!blockedAtPlanning.allowed, "Execution must be blocked before plan review");
  assert(
    String(blockedAtPlanning.reason || "").includes("phase=planning"),
    "Block reason should indicate planning phase"
  );
  const reviewPromise = runtimeManager.requestPlanReview(windowId, {
    planSummary: "Open page, collect table, summarize.",
    plan: ["Open page", "Inspect data", "Summarize findings"]
  });
  const blockedAtReview = await runtimeManager.waitUntilExecutable(windowId);
  assert(!blockedAtReview.allowed, "Execution must stay blocked in plan_review phase");
  assert(
    String(blockedAtReview.reason || "").includes("phase=plan_review"),
    "Block reason should indicate plan_review phase"
  );
  await delay(5);
  const accepted = await runtimeManager.submitPlanReviewDecision({
    windowId,
    decision: "approve"
  });
  assert(accepted, "Plan review decision should be accepted by runtime");
  const reviewDecision = await reviewPromise;
  assertEqual(reviewDecision.decision, "approve", "Plan decision should resolve as approve");
  const allowedAfterApproval = await runtimeManager.waitUntilExecutable(windowId);
  assert(allowedAfterApproval.allowed, "Execution must be allowed after plan approval");
}
async function testPauseResumeBlocking() {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9102;
  const tabId = 92;
  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: "step_through",
    gatePolicy: "adaptive"
  });
  await runtimeManager.setExecutionPhase(windowId, "execution", "test_setup");
  await runtimeManager.setExecutionState(windowId, "running", "test_setup", "system");
  await runtimeManager.pauseByUser(windowId);
  const paused = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(paused.executionState, "paused_by_user", "Pause should set executionState=paused_by_user");
  assertEqual(paused.authorityState, "human_control", "Pause should transfer authority to human_control");
  const waitPromise = runtimeManager.waitUntilExecutable(windowId);
  const race = await Promise.race([
    waitPromise.then(() => "resolved"),
    delay(40).then(() => "timeout")
  ]);
  assertEqual(race, "timeout", "Paused execution should block runtime progression");
  await runtimeManager.resumeByUser(windowId);
  const resumedResult = await waitPromise;
  assert(resumedResult.allowed, "Execution should continue after resume");
  const resumed = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(resumed.executionState, "running", "Resume should restore running executionState");
  assertEqual(resumed.authorityState, "shared_supervision", "Resume should restore shared supervision");
}
async function testTakeoverReleaseBlocking() {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9103;
  const tabId = 93;
  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: "risky_only",
    gatePolicy: "impact"
  });
  await runtimeManager.setExecutionPhase(windowId, "execution", "test_setup");
  await runtimeManager.transitionAuthority(windowId, "shared_supervision", "test_setup");
  await runtimeManager.takeover(windowId);
  const takenOver = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(takenOver.authorityState, "human_control", "Takeover should set human_control");
  assertEqual(takenOver.executionState, "paused_by_user", "Takeover should freeze execution");
  const blocked = runtimeManager.waitUntilExecutable(windowId);
  const race = await Promise.race([
    blocked.then(() => "resolved"),
    delay(40).then(() => "timeout")
  ]);
  assertEqual(race, "timeout", "Takeover should block agent execution until release");
  await runtimeManager.releaseControl(windowId);
  const released = await blocked;
  assert(released.allowed, "Execution should resume after release control");
  const snapshot = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(snapshot.authorityState, "agent_autonomous", "Release should return authority to autonomous");
  assertEqual(snapshot.executionState, "running", "Release should unfreeze execution");
}
async function testRhythmMetricsExport() {
  installChromeMock();
  const logger = new OversightTelemetryLogger();
  const sessionId = "s-rhythm-check";
  logger.log({
    sessionId,
    timestamp: 1e3,
    source: "system",
    eventType: "oversight_signal",
    payload: { kind: "intervention_prompted", stepId: "step_1" }
  });
  logger.log({
    sessionId,
    timestamp: 2e3,
    source: "human",
    eventType: "human_intervention",
    payload: { kind: "execution_paused", by: "user" }
  });
  logger.log({
    sessionId,
    timestamp: 3e3,
    source: "human",
    eventType: "human_intervention",
    payload: { kind: "authority_takeover", previous: "shared_supervision" }
  });
  logger.log({
    sessionId,
    timestamp: 3500,
    source: "system",
    eventType: "state_transition",
    payload: { kind: "authority_transition", from: "shared_supervision", to: "human_control" }
  });
  logger.log({
    sessionId,
    timestamp: 4200,
    source: "system",
    eventType: "state_transition",
    payload: { kind: "authority_transition", from: "human_control", to: "agent_autonomous" }
  });
  const exported = await logger.exportSessionLog(sessionId);
  const parsed = JSON.parse(exported);
  assert(parsed.oversightRhythmMetrics, "Export should contain oversightRhythmMetrics");
  assertEqual(parsed.oversightRhythmMetrics?.totalInterruptions ?? -1, 3, "totalInterruptions should match");
  assertEqual(parsed.oversightRhythmMetrics?.enforcedInterruptions ?? -1, 1, "enforcedInterruptions should match");
  assertEqual(
    parsed.oversightRhythmMetrics?.userInitiatedInterruptions ?? -1,
    2,
    "userInitiatedInterruptions should match"
  );
  assertEqual(
    Math.round(parsed.oversightRhythmMetrics?.meanInterruptionIntervalMs ?? -1),
    1e3,
    "meanInterruptionIntervalMs should match expected average"
  );
  assertEqual(
    parsed.oversightRhythmMetrics?.authorityTransitionCount ?? -1,
    2,
    "authorityTransitionCount should match"
  );
}
async function testAdaptiveEscalationAuthorityTransition() {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9104;
  const tabId = 94;
  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: "risky_only",
    gatePolicy: "adaptive"
  });
  await runtimeManager.setExecutionPhase(windowId, "execution", "test_setup");
  const initial = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(initial.authorityState, "shared_supervision", "Adaptive profile should initialize shared supervision");
  await runtimeManager.transitionAuthority(windowId, "agent_autonomous", "test_force_baseline");
  const baseline = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(baseline.authorityState, "agent_autonomous", "Baseline authority should be autonomous for escalation test");
  await runtimeManager.handleAdaptiveRiskSignal({
    windowId,
    gatePolicy: "adaptive",
    promptedByGate: true,
    impact: "high"
  });
  const escalated = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(
    escalated.authorityState,
    "shared_supervision",
    "Adaptive prompt should escalate authority to shared supervision"
  );
  await runtimeManager.handleAdaptiveRiskSignal({
    windowId,
    gatePolicy: "adaptive",
    promptedByGate: false,
    impact: "low"
  });
  const resolved = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(
    resolved.authorityState,
    "agent_autonomous",
    "Low-risk adaptive signal should resolve authority back to autonomous"
  );
}
async function runRuntimePhase3E2ETests() {
  await testPlanReviewBlocking();
  await testPauseResumeBlocking();
  await testTakeoverReleaseBlocking();
  await testRhythmMetricsExport();
  await testAdaptiveEscalationAuthorityTransition();
}
async function main() {
  try {
    await runRuntimePhase3E2ETests();
    console.log("Runtime Phase 3 e2e checks passed.");
  } catch (error) {
    console.error("Runtime Phase 3 e2e checks failed:", error);
    process.exitCode = 1;
  }
}
void main();
export {
  runRuntimePhase3E2ETests
};
