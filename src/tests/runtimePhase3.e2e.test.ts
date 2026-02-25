import { getOversightRuntimeManager } from '../oversight/runtime/runtimeManager';
import { OversightTelemetryLogger } from '../oversight/telemetry/logger';
import { assert, assertEqual } from './testUtils';

type StorageRecord = Record<string, unknown>;

function installChromeMock(initialLocal: StorageRecord = {}, initialSync: StorageRecord = {}): void {
  const localData: StorageRecord = { ...initialLocal };
  const syncData: StorageRecord = {
    'telemetry.redactionLevel': 'normal',
    'telemetry.redactionMaxTextLength': 320,
    ...initialSync,
  };

  const runtimeMessages: Array<Record<string, unknown>> = [];

  (globalThis as unknown as { chrome: typeof chrome & { __runtimeMessages?: Array<Record<string, unknown>> } }).chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const item of key) out[item] = localData[item];
            return out;
          }
          return { [key]: localData[key] };
        },
        set: async (value: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(value)) localData[k] = v;
        },
        remove: async (key: string | string[]) => {
          if (Array.isArray(key)) {
            for (const item of key) delete localData[item];
            return;
          }
          delete localData[key];
        },
      },
      sync: {
        get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...syncData }),
        set: async (value: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(value)) syncData[k] = v;
        },
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage: (message: Record<string, unknown>, callback?: (response?: unknown) => void) => {
        runtimeMessages.push(message);
        if (callback) callback({ success: true });
      },
    },
    __runtimeMessages: runtimeMessages,
  } as unknown as typeof chrome & { __runtimeMessages: Array<Record<string, unknown>> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPlanReviewBlocking(): Promise<void> {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9101;
  const tabId = 91;

  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: 'risky_only',
    gatePolicy: 'impact',
  });

  const initial = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(initial.executionPhase, 'planning', 'Initial phase should be planning');

  const blockedAtPlanning = await runtimeManager.waitUntilExecutable(windowId);
  assert(!blockedAtPlanning.allowed, 'Execution must be blocked before plan review');
  assert(
    String(blockedAtPlanning.reason || '').includes('phase=planning'),
    'Block reason should indicate planning phase'
  );

  const reviewPromise = runtimeManager.requestPlanReview(windowId, {
    planSummary: 'Open page, collect table, summarize.',
    plan: ['Open page', 'Inspect data', 'Summarize findings'],
  });

  const blockedAtReview = await runtimeManager.waitUntilExecutable(windowId);
  assert(!blockedAtReview.allowed, 'Execution must stay blocked in plan_review phase');
  assert(
    String(blockedAtReview.reason || '').includes('phase=plan_review'),
    'Block reason should indicate plan_review phase'
  );

  // Ensure async plan-review registration has completed before submitting decision.
  await delay(5);
  const accepted = await runtimeManager.submitPlanReviewDecision({
    windowId,
    decision: 'approve',
  });
  assert(accepted, 'Plan review decision should be accepted by runtime');

  const reviewDecision = await reviewPromise;
  assertEqual(reviewDecision.decision, 'approve', 'Plan decision should resolve as approve');

  const allowedAfterApproval = await runtimeManager.waitUntilExecutable(windowId);
  assert(allowedAfterApproval.allowed, 'Execution must be allowed after plan approval');
}

async function testPauseResumeBlocking(): Promise<void> {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9102;
  const tabId = 92;

  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: 'step_through',
    gatePolicy: 'adaptive',
  });
  await runtimeManager.setExecutionPhase(windowId, 'execution', 'test_setup');
  await runtimeManager.setExecutionState(windowId, 'running', 'test_setup', 'system');

  await runtimeManager.pauseByUser(windowId);
  const paused = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(paused.executionState, 'paused_by_user', 'Pause should set executionState=paused_by_user');
  assertEqual(paused.authorityState, 'human_control', 'Pause should transfer authority to human_control');

  const waitPromise = runtimeManager.waitUntilExecutable(windowId);
  const race = await Promise.race([
    waitPromise.then(() => 'resolved'),
    delay(40).then(() => 'timeout'),
  ]);
  assertEqual(race, 'timeout', 'Paused execution should block runtime progression');

  await runtimeManager.resumeByUser(windowId);
  const resumedResult = await waitPromise;
  assert(resumedResult.allowed, 'Execution should continue after resume');

  const resumed = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(resumed.executionState, 'running', 'Resume should restore running executionState');
  assertEqual(resumed.authorityState, 'shared_supervision', 'Resume should restore shared supervision');
}

async function testTakeoverReleaseBlocking(): Promise<void> {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9103;
  const tabId = 93;

  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: 'risky_only',
    gatePolicy: 'impact',
  });
  await runtimeManager.setExecutionPhase(windowId, 'execution', 'test_setup');
  await runtimeManager.transitionAuthority(windowId, 'shared_supervision', 'test_setup');

  await runtimeManager.takeover(windowId);
  const takenOver = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(takenOver.authorityState, 'human_control', 'Takeover should set human_control');
  assertEqual(takenOver.executionState, 'paused_by_user', 'Takeover should freeze execution');

  const blocked = runtimeManager.waitUntilExecutable(windowId);
  const race = await Promise.race([
    blocked.then(() => 'resolved'),
    delay(40).then(() => 'timeout'),
  ]);
  assertEqual(race, 'timeout', 'Takeover should block agent execution until release');

  await runtimeManager.releaseControl(windowId);
  const released = await blocked;
  assert(released.allowed, 'Execution should resume after release control');

  const snapshot = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(snapshot.authorityState, 'agent_autonomous', 'Release should return authority to autonomous');
  assertEqual(snapshot.executionState, 'running', 'Release should unfreeze execution');
}

async function testRhythmMetricsExport(): Promise<void> {
  installChromeMock();
  const logger = new OversightTelemetryLogger();
  const sessionId = 's-rhythm-check';

  logger.log({
    sessionId,
    timestamp: 1000,
    source: 'system',
    eventType: 'oversight_signal',
    payload: { kind: 'intervention_prompted', stepId: 'step_1' },
  });
  logger.log({
    sessionId,
    timestamp: 2000,
    source: 'human',
    eventType: 'human_intervention',
    payload: { kind: 'execution_paused', by: 'user' },
  });
  logger.log({
    sessionId,
    timestamp: 3000,
    source: 'human',
    eventType: 'human_intervention',
    payload: { kind: 'authority_takeover', previous: 'shared_supervision' },
  });
  logger.log({
    sessionId,
    timestamp: 3500,
    source: 'system',
    eventType: 'state_transition',
    payload: { kind: 'authority_transition', from: 'shared_supervision', to: 'human_control' },
  });
  logger.log({
    sessionId,
    timestamp: 4200,
    source: 'system',
    eventType: 'state_transition',
    payload: { kind: 'authority_transition', from: 'human_control', to: 'agent_autonomous' },
  });
  logger.log({
    sessionId,
    timestamp: 4500,
    source: 'system',
    eventType: 'oversight_signal',
    payload: { kind: 'behavioral_signal_captured', signal: 'pause_by_user' },
  });
  logger.log({
    sessionId,
    timestamp: 5000,
    source: 'system',
    eventType: 'state_transition',
    payload: { kind: 'regime_transition', from: 'baseline', to: 'deliberative_escalated', trigger: 'behavioral' },
  });
  logger.log({
    sessionId,
    timestamp: 8000,
    source: 'system',
    eventType: 'state_transition',
    payload: { kind: 'regime_transition', from: 'deliberative_escalated', to: 'baseline', trigger: 'behavioral' },
  });

  const exported = await logger.exportSessionLog(sessionId);
  const parsed = JSON.parse(exported) as {
    oversightRhythmMetrics?: {
      totalInterruptions: number;
      enforcedInterruptions: number;
      userInitiatedInterruptions: number;
      meanInterruptionIntervalMs: number;
      authorityTransitionCount: number;
    };
    oversightEscalationMetrics?: {
      totalEscalations: number;
      meanEscalationDurationMs: number;
      maxEscalationDurationMs: number;
      escalationTriggerDistribution: {
        pause: number;
        trace_expand: number;
        hover: number;
        edit: number;
      };
      resolutionLatencyMs: number;
    };
  };

  assert(parsed.oversightRhythmMetrics, 'Export should contain oversightRhythmMetrics');
  assertEqual(parsed.oversightRhythmMetrics?.totalInterruptions ?? -1, 3, 'totalInterruptions should match');
  assertEqual(parsed.oversightRhythmMetrics?.enforcedInterruptions ?? -1, 1, 'enforcedInterruptions should match');
  assertEqual(
    parsed.oversightRhythmMetrics?.userInitiatedInterruptions ?? -1,
    2,
    'userInitiatedInterruptions should match'
  );
  assertEqual(
    Math.round(parsed.oversightRhythmMetrics?.meanInterruptionIntervalMs ?? -1),
    1000,
    'meanInterruptionIntervalMs should match expected average'
  );
  assertEqual(
    parsed.oversightRhythmMetrics?.authorityTransitionCount ?? -1,
    2,
    'authorityTransitionCount should match'
  );
  assert(parsed.oversightEscalationMetrics, 'Export should contain oversightEscalationMetrics');
  assertEqual(parsed.oversightEscalationMetrics?.totalEscalations ?? -1, 1, 'totalEscalations should match');
  assertEqual(
    Math.round(parsed.oversightEscalationMetrics?.meanEscalationDurationMs ?? -1),
    3000,
    'meanEscalationDurationMs should match'
  );
  assertEqual(
    parsed.oversightEscalationMetrics?.escalationTriggerDistribution.pause ?? -1,
    1,
    'pause trigger count should match'
  );
  assertEqual(
    Math.round(parsed.oversightEscalationMetrics?.resolutionLatencyMs ?? -1),
    3000,
    'resolutionLatencyMs should match'
  );
}

async function testAdaptiveEscalationAuthorityTransition(): Promise<void> {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9104;
  const tabId = 94;

  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: 'risky_only',
    gatePolicy: 'adaptive',
  });
  await runtimeManager.setExecutionPhase(windowId, 'execution', 'test_setup');

  const initial = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(initial.authorityState, 'shared_supervision', 'Adaptive profile should initialize shared supervision');

  await runtimeManager.transitionAuthority(windowId, 'agent_autonomous', 'test_force_baseline');
  const baseline = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(baseline.authorityState, 'agent_autonomous', 'Baseline authority should be autonomous for escalation test');

  await runtimeManager.handleAdaptiveRiskSignal({
    windowId,
    gatePolicy: 'adaptive',
    promptedByGate: true,
    impact: 'high',
  });
  const escalated = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(
    escalated.authorityState,
    'shared_supervision',
    'Adaptive prompt should escalate authority to shared supervision'
  );

  await runtimeManager.handleAdaptiveRiskSignal({
    windowId,
    gatePolicy: 'adaptive',
    promptedByGate: false,
    impact: 'low',
  });
  const resolved = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(
    resolved.authorityState,
    'agent_autonomous',
    'Low-risk adaptive signal should resolve authority back to autonomous'
  );
}

async function testBehavioralRegimeEscalationAndResolution(): Promise<void> {
  installChromeMock();
  const runtimeManager = getOversightRuntimeManager();
  const windowId = 9105;
  const tabId = 95;

  runtimeManager.initializeRun({
    tabId,
    windowId,
    controlMode: 'risky_only',
    gatePolicy: 'impact',
    runtimePolicyBaseline: {
      monitoringContentScope: 'standard',
      explanationAvailability: 'summary',
      userActionOptions: 'basic',
      persistenceMs: 0,
      tightenHighImpactAuthority: false,
    },
    structuralAmplification: {
      enabled: true,
      deliberationThreshold: 3,
      signalDecayMs: 10000,
      sustainedWindowMs: 10000,
      resolutionWindowMs: 100,
      escalationPersistenceMs: 300000,
    },
  });

  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'open_oversight_tab', source: 'ui' });
  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'expand_trace_node', source: 'ui' });
  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'hover_risk_label', durationMs: 1200, source: 'ui' });

  const escalated = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(escalated.regime, 'deliberative_escalated', 'Behavioral threshold should escalate regime');
  assertEqual(escalated.runtimePolicy.monitoringContentScope, 'full', 'Escalated policy should force full scope');
  assertEqual(escalated.runtimePolicy.explanationAvailability, 'full', 'Escalated policy should force full explanation');
  assertEqual(escalated.runtimePolicy.userActionOptions, 'extended', 'Escalated policy should extend user actions');

  await runtimeManager.resolveEscalation(windowId);
  const manualResolved = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(manualResolved.regime, 'baseline', 'Manual exit should resolve regime to baseline immediately');
  assertEqual(manualResolved.runtimePolicy.monitoringContentScope, 'standard', 'Manual exit should restore baseline policy');

  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'open_oversight_tab', source: 'ui' });
  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'expand_trace_node', source: 'ui' });
  await runtimeManager.handleBehavioralSignal({ windowId, signal: 'hover_risk_label', durationMs: 1000, source: 'ui' });

  const reEscalated = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(reEscalated.regime, 'deliberative_escalated', 'Behavioral signals after manual exit should re-enter escalated regime');

  await delay(1200);
  const resolved = runtimeManager.getSnapshot(runtimeManager.runtimeKey(windowId));
  assertEqual(resolved.regime, 'baseline', 'Inactivity should resolve regime to baseline');
  assertEqual(resolved.runtimePolicy.monitoringContentScope, 'standard', 'Baseline policy should be restored');
  assertEqual(resolved.runtimePolicy.userActionOptions, 'basic', 'Baseline user actions should be restored');

  runtimeManager.clear(windowId);
}

export async function runRuntimePhase3E2ETests(): Promise<void> {
  await testPlanReviewBlocking();
  await testPauseResumeBlocking();
  await testTakeoverReleaseBlocking();
  await testRhythmMetricsExport();
  await testAdaptiveEscalationAuthorityTransition();
  await testBehavioralRegimeEscalationAndResolution();
}

async function main(): Promise<void> {
  try {
    await runRuntimePhase3E2ETests();
    console.log('Runtime Phase 3 e2e checks passed.');
  } catch (error) {
    console.error('Runtime Phase 3 e2e checks failed:', error);
    process.exitCode = 1;
  }
}

void main();
