# MORPH

**MORPH** stands for **Modular Oversight Runtime for Programmable Human–agent systems**.

`gui-agent-oversight` is a Chrome Extension (Manifest V3) for testing and comparing **oversight mechanisms** for GUI agents.

It now also serves as a **Programmable Oversight Interaction Research Platform** with a telemetry-first interaction layer.

It provides a shared runtime for browser automation plus a pluggable oversight layer, so you can:
- run the same agent tasks under different oversight policies
- turn mechanisms on/off from a registry-driven settings UI
- add new mechanisms with minimal changes to core agent code

The current extension name in `public/manifest.json` is `MORPH`.

## What This Platform Includes

- Side panel chat UI for prompt execution and streamed agent output
- Background controller for tab/session lifecycle and tool execution
- Oversight event pipeline between runtime and UI
- Registry-based oversight mechanism settings
- Optional approval flow for risky actions
- Interaction telemetry with session lifecycle and JSON export
- Parameterized oversight policies (per-mechanism configurable parameters)
- Runtime authority architecture (authority/phase/execution state)
- Design-space metadata for mechanisms and design matrix export
- Task graph step export (download current task steps as JSON)
- Experiment configuration DSL and runner for batch studies
- Runtime e2e verification script for Phase 3 blocking/transition guarantees
- Multi-provider model support (Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible, OpenRouter)

## Research Platform Features

### Phase 1: Interaction Telemetry Layer

- Telemetry event model: `src/oversight/telemetry/types.ts`
- Telemetry logger: `src/oversight/telemetry/logger.ts`
- Session lifecycle manager: `src/oversight/session/sessionManager.ts`
- Background + side-panel interaction points now emit telemetry:
  - tool lifecycle (`tool_started`, `tool_completed`, `tool_failed`)
  - risk/approval signals
  - human intervention and monitoring actions
- Session logs can be exported as JSON via the telemetry logger.

### Phase 2: Parameterized Oversight Policies

- Registry supports parameter descriptors (`number` / `boolean` / `enum`) in `src/oversight/registry.ts`.
- Storage supports parameter keys with format:
  - `oversight.<mechanismId>.<paramKey>`
- Options UI renders and saves mechanism parameters automatically.
- Reducer context now supports parameter lookup:
  - `ctx.getParameter(mechanismId, paramKey)`
- Mechanism logic is parameter-driven (e.g. task graph node cap and auto-expand behavior).

### Phase 3: Runtime Authority Architecture

MORPH now has first-class runtime primitives for authority, phase, and execution state.

- Runtime managers:
  - `src/oversight/runtime/authorityManager.ts`
  - `src/oversight/runtime/phaseManager.ts`
  - `src/oversight/runtime/executionStateManager.ts`
  - `src/oversight/runtime/runtimeManager.ts`
- Authority state machine:
  - `agent_autonomous | shared_supervision | human_control`
- Execution phases:
  - `planning | plan_review | execution | posthoc_review | terminated`
- Execution states:
  - `running | paused_by_user | paused_by_system | paused_by_system_soft | cancelled | completed`
- Runtime-level guarantees:
  - plan review can block execution before first action
  - the execution engine is phase-aware and refuses tool invocation unless `ExecutionPhase === 'execution'` and `ExecutionState === 'running'`
  - execution blocking is enforced at the runtime engine layer (not the UI layer), so authority/phase constraints cannot be bypassed via presentation-level manipulation
  - pause freezes execution until explicit resume
  - when Structural Amplification is active, each tool invocation is held by a runtime-enforced soft window (`paused_by_system_soft`) for 2–3s before execution
- Side panel controls:
  - Pause / Resume (icon buttons in composer area) + Cancel
  - amplified-mode indicator + explicit return-to-normal action
- Runtime telemetry/events include:
  - `authority_transition`
  - `execution_phase_changed`
  - `execution_state_changed`
  - `plan_review_requested`
  - `plan_review_decision`
  - `amplification_entered`
  - `amplification_exited`
  - `intent_refresh_triggered`
  - `intent_refresh_confirmed`
  - `soft_pause_started`
  - `soft_pause_resolved`
- Session export now appends `oversightRhythmMetrics`:
  - `totalInterruptions`
  - `enforcedInterruptions`
  - `userInitiatedInterruptions`
  - `meanInterruptionIntervalMs`
  - `authorityTransitionCount`
  - `amplificationDurationMs`
  - `amplificationEntryCount`
  - `meanSoftPauseDurationMs`
  - `intentRefreshCount`

#### Oversight Rhythm Instrumentation

The runtime architecture enables formal measurement of oversight rhythm.
Oversight rhythm is defined as the temporal structure of enforced and user-initiated regulatory events across execution.
Each session export includes derived metrics capturing interruption density, enforcement ratio, and authority transitions, enabling quantitative comparison of oversight archetypes.

#### 0) Sidepanel Interaction Surface (Runtime UI)

- Layout mode:
  - two primary tabs: `Conversation` and `Oversight`
  - approvals remain popup-style overlays (independent from active tab)
- Runtime status strip:
  - compact status strip focused on amplification state
  - when a plan is approved/edited, `Inspect Plan` is available during execution (not only at plan-review time)
  - no persistent authority/phase/state text badges
  - pause/resume are surfaced as direct icon actions in composer area
- Conversation rendering:
  - timeline-style step flow (dot/line rhythm)
  - tool/action chips inferred from tool call tags
  - XML metadata tags are rendered as structured cards, not raw text

#### 1) Task Graph (`task-graph`)

- `maxNodes` (`number`)
  - Max number of nodes retained in task graph.
- `contentGranularity` (`enum: task | step | substep`)
  - `task`: summary-level view.
  - `step`: per-step node view (default).
  - `substep`: reserved for tool-call level detail (current UI treats it similarly to step).
- `informationDensity` (`enum: compact | balanced | detailed`)
  - Controls vertical density and graph viewport height.
- `colorEncoding` (`enum: semantic | monochrome | high_contrast`)
  - Controls node/status visual encoding style.

#### 2) Monitoring (`monitoring`)

- `monitoringContentScope` (`enum: minimal | standard | full`)
  - Controls how much metadata is shown in oversight panels.
- `explanationAvailability` (`enum: none | summary | full`)
  - `none`: hides step explanations.
  - `summary`: shortened explanation text.
  - `full`: full explanation/rationale text.
- `explanationFormat` (`enum: text | snippet | diff`)
  - `text`: standard narrative explanation.
  - `snippet`: short clipped explanation.
  - `diff`: heuristic-vs-LLM style risk explanation view.
- `notificationModality` (`enum: badge | modal | mixed`)
  - `badge`: non-blocking badge entry point for approvals.
  - `modal`: approval popup overlay directly.
  - `mixed`: both badge and popup behavior.
- `feedbackLatencyMs` (`number`)
  - Delay before approval prompts are shown.
- `persistenceMs` (`number`)
  - Auto-dismiss/timeout for approval prompts (auto-reject on expiry).
- `showPostHocPanel` (`boolean`)
  - Shows post-hoc session summary in oversight tab (step count, high-risk count, decisions).

#### 3) Intervention Gate (`interventionGate`)

- `gatePolicy` (`enum: never | always | impact | adaptive`)
  - Core gate strategy for whether a step should be gated.
  - Note: `impact` is a legacy key name; behavior is risk-based.
- `controlMode` (`enum: approve_all | risky_only | step_through`)
  - `approve_all`: bypass pre-action approvals.
  - `risky_only`: only risky/gated actions request approval.
  - `step_through`: every step requests approval.
- `timingPolicy` (`enum: pre_action | pre_navigation | post_action`)
  - `pre_action`: standard approval before execution.
  - `pre_navigation`: pre-action approval only for navigation tools.
  - `post_action`: execute step first, then require post-action review.
    - If post-action review is denied, execution is hard-stopped.
- `interruptCooldownMs` (`number`)
  - Minimum interval between approval prompts; during cooldown requests are auto-approved.
- `interruptTopK` (`number`)
  - Per-minute cap for approval prompts; beyond cap requests are auto-approved.
- `userActionOptions` (`enum: basic | extended`)
  - `basic`: approve / reject / dismiss.
  - `extended`: approve / reject / dismiss + edit / retry / rollback controls in popup.

#### 4) Conversation Rendering Features

LLM step metadata tags are parsed and rendered as structured cards in conversation:

- `<thinking_summary>...</thinking_summary>`

`<impact>`, `<impact_rationale>`, and amplified scaffold text are stripped from conversation rendering.
Risk analysis and amplified deliberation details are surfaced in the Oversight panel instead.

This avoids raw XML clutter and preserves readable step-level context.

#### 5) Structural Amplification (`structuralAmplification`)

- Runtime amplification state machine:
  - `normal | amplified`
  - enter on any:
    - rapid pause->resume (`<=5s`)
    - `Inspect Plan`
    - repeated trace expansion within short window
  - exit on:
    - inactivity across consecutive steps
    - explicit return-to-normal action
    - task boundary (`ExecutionPhase=posthoc_review`)
- Micro-deliberation soft window (not approval gating):
  - independent from `interventionGate.gatePolicy`
  - before tool invocation, runtime may enter `paused_by_system_soft`
  - sidepanel shows an inline countdown banner (`Next action will execute...`) to avoid obscuring oversight content
  - user options: `Continue now` or `Pause`; otherwise auto-resume on timeout
- Amplified schema injection:
  - requires scaffold before action:
    - `Next Step I Plan To Do:`
    - `Alternative:`
    - `Why I choose A over B:`
- Lightweight risk surfacing in amplified mode:
  - heuristic metadata badge in timeline:
    - `effect_type: reversible | irreversible`
    - `scope: local | external`
    - `data_flow: disclosure | none`
  - per-step `Planned Deliberation` is shown in Oversight node details:
    - next step / alternative / why A over B
- Intent refresh:
  - every N steps in amplified mode, runtime emits a non-blocking intent refresh prompt
  - auto-confirmation is logged if user does not intervene

#### 6) Plan Generation + Review

- Plan is generated via a dedicated planning prompt (separate from single-step thinking metadata).
- Planner output is normalized into multi-step, text-only actionable steps.
- Plan review supports:
  - approve
  - reject
  - user-friendly multi-step editing UI (add/remove/edit step text)
- Approved or edited plan is injected as persistent execution guidance and affects subsequent agent steps.
- During execution, users can open `Inspect Plan` at any time from the runtime status strip to view:
  - completed plan steps
  - current step in progress
  - pending steps

#### 7) Interaction Feature Snapshot (Paper Alignment)

Use this as a quick implementation audit against the Strategy/Presentation design space.

- Strategy layer:
  - `Signal Scope`: partial (plan/step/substep/risk/rationale available; DOM-level signal not first-class)
  - `Monitoring Granularity`: supported (`task | step | substep`)
  - `Exposure Policy`: supported (`full/selective/risk-triggered` via monitoring scope + gate policy)
  - `Initiative Allocation`: partial (agent-triggered + user-triggered supported; no strict user-invoked-only suppression mode)
  - `Trigger Timing`: supported (`pre_action | pre_navigation | post_action`; continuous approximated via persistent trace UI)
  - `Intervention Frequency`: supported (`step_through`, risk-gated, cooldown, top-k budget)
  - `Escalation Policy`: supported (`adaptive` gating can transition authority state)
  - `Authority Model`: fully supported (runtime authority state machine, explicit transitions, telemetry)
  - `Intervention Mechanism`: supported (approve/deny + optional edit/retry/rollback + runtime pause/resume)
  - `Plan-Level Control`: supported (plan review + approve/reject + multi-step editing workflow)
- Presentation layer:
  - `Representation Format`: partial (`text/snippet/diff`, timeline cards, overlays; DOM diff overlay pipeline limited)
  - `Reasoning Transparency`: supported (`none | summary | full`)
  - `Uncertainty Disclosure`: partial (`low|medium|high` tiers; no calibrated confidence score)
  - `Visual Encoding`: supported (badge/color encoding + density controls)
  - `Risk Tiering`: supported (`low|medium|high`; no dedicated binary-only mode switch)
  - `Confirmation Gating`: supported (high-risk-only vs every-step vs policy-off)
  - `Alert Latency`: supported (`feedbackLatencyMs`)
  - `Cue Persistence`: supported (`persistenceMs` + persistent trace panels)
  - `Status Feedback`: supported (task graph, oversight trace, post-hoc summary)

### Design Space Mapping (Implemented vs Partial)

The following maps the research design space to currently configurable runtime/UI parameters.

#### Strategy Dimensions

- Signal Scope
  - Current controls: `monitoring.monitoringContentScope` (`minimal | standard | full`)
  - Coverage: partial approximation of `plan / step / substep / DOM / risk label / rationale`
- Monitoring Granularity
  - Current controls: `task-graph.contentGranularity` (`task | step | substep`)
  - Coverage: task/step/substep supported; explicit DOM-level monitoring not first-class
- Exposure Policy
  - Current controls: `monitoring.monitoringContentScope`, `interventionGate.gatePolicy`
  - Coverage: full/selective/risk-triggered patterns supported
- Initiative Allocation
  - Current controls: indirect via `notificationModality` + panel inspection
  - Coverage: agent-triggered and user-triggered initiation supported (including pause/resume and plan-review decisions); no pure user-invoked-only signaling suppression mode yet
- Trigger Timing
  - Current controls: `interventionGate.timingPolicy` (`pre_action | pre_navigation | post_action`)
  - Coverage: pre/post supported; continuous approximated through persistent monitoring UI
- Intervention Frequency
  - Current controls: `interventionGate.gatePolicy`, `controlMode`, `interruptCooldownMs`, `interruptTopK`
  - Coverage: per-step/per-action/risk-triggered patterns configurable
- Escalation Policy
  - Current controls: `interventionGate.gatePolicy=adaptive`, `adaptiveController` mechanism
  - Coverage: static and adaptive supported; adaptive risk signals can trigger authority state transitions (escalate/resolve)
- Authority Model
  - Current controls: `interventionGate.controlMode`
  - Coverage: fully supported as a runtime-level authority state machine with explicit transitions and telemetry
- Intervention Mechanism
  - Current controls: `interventionGate.userActionOptions` (`basic | extended`)
  - Coverage: approve/deny + optional edit/retry/rollback, plus first-class runtime controls for pause/resume
- Plan-Level Control
  - Current controls: runtime plan-review gate before execution (`plan_review` phase)
  - Coverage: plan-level preview/approval/editing is supported with runtime-time inspect + progress tracking

#### Presentation Dimensions

- Representation Format
  - Current controls: `monitoring.explanationFormat` (`text | snippet | diff`), oversight tabs, approval overlay
  - Coverage: text/snippet/diff supported; rich DOM overlay comparison is limited
- Reasoning Transparency
  - Current controls: `monitoring.explanationAvailability` (`none | summary | full`)
  - Coverage: none/partial/full supported
- Uncertainty Disclosure
  - Current controls: risk labels (`low | medium | high`) in oversight/task graph
  - Coverage: partial; explicit calibrated confidence score is not exposed
- Visual Encoding
  - Current controls: `task-graph.colorEncoding` (`semantic | monochrome | high_contrast`)
  - Coverage: color/badge style encoding supported
- Risk Tiering
  - Current controls: runtime risk tiers (`low | medium | high`)
  - Coverage: 3-tier supported; binary-only mode not a dedicated toggle
- Confirmation Gating
  - Current controls: `interventionGate.gatePolicy`, `controlMode`, approval popup/badge modality
  - Coverage: explicit gating supported (high-risk-only or every action)
- Alert Latency
  - Current controls: `monitoring.feedbackLatencyMs`
  - Coverage: immediate/delayed supported
- Cue Persistence
  - Current controls: `monitoring.persistenceMs`, persistent oversight/task graph panels
  - Coverage: ephemeral/episodic/persistent approximations supported
- Status Feedback
  - Current controls: task graph + oversight trace + post-hoc panel (`monitoring.showPostHocPanel`)
  - Coverage: progress/trace feedback supported

### Built-in Archetypes

The runtime includes 3 built-in presets:

Each preset also initializes runtime state at run start through its policy profile:
- initial `ExecutionPhase` starts at `planning` and moves through `plan_review` into `execution`
- initial `AuthorityState` mapping:
  - `Risk-Gated Oversight` -> `agent_autonomous`
  - `Supervisory Co-Execution` -> `shared_supervision`
  - `Action-Confirmation Oversight` -> `shared_supervision` (with step-through style gating behavior)
- `AuthorityState` can transition during runtime via pause/resume and escalation flows

1. `Risk-Gated Oversight`
- Autonomous-by-default with selective risk-triggered intervention
- Core mapping:
  - mechanisms: `agent-focus=true`, `task-graph=true`, `monitoring=true`, `interventionGate=true`, `adaptiveController=false`
  - `gatePolicy=impact`
  - `controlMode=risky_only`
  - `timingPolicy=pre_action`
  - `monitoringContentScope=standard`
  - `explanationAvailability=summary`

2. `Supervisory Co-Execution`
- Continuous visibility and collaborative control with adaptive escalation
- Core mapping:
  - mechanisms: `agent-focus=true`, `task-graph=true`, `monitoring=true`, `interventionGate=true`, `adaptiveController=true`
  - `gatePolicy=adaptive`
  - `controlMode=step_through`
  - `monitoringContentScope=full`
  - `explanationAvailability=full`
  - `explanationFormat=snippet`
  - `contentGranularity=substep`
  - `informationDensity=detailed`
  - `colorEncoding=high_contrast`
  - `persistenceMs=300000`
  - `userActionOptions=extended`
  - `adaptiveController=true`

3. `Action-Confirmation Oversight`
- Human-veto-by-default with minimal disclosure and per-action confirmation
- Core mapping:
  - mechanisms: `agent-focus=false`, `task-graph=false`, `monitoring=true`, `interventionGate=true`, `adaptiveController=false`
  - `gatePolicy=always`
  - `controlMode=step_through`
  - `timingPolicy=pre_action`
  - `monitoringContentScope=minimal`
  - `explanationAvailability=none`
  - `notificationModality=modal`

### Not Fully Implemented Yet

- Semantic plan-progress alignment (current progress maps by step order, not semantic step matching)
- Native confidence score / uncertainty calibration output in UI
- First-class initiative policy switch (`agent-triggered` vs `user-invoked` vs `mixed`)
- DOM-level diff/snippet explanation pipeline with robust snapshot alignment

#### Example Configurations

Use these as starting presets:

1. Low-interruption baseline
```text
gatePolicy=impact
controlMode=risky_only
timingPolicy=pre_navigation
notificationModality=badge
feedbackLatencyMs=0
persistenceMs=0
explanationAvailability=summary
informationDensity=compact
```

2. Balanced oversight
```text
gatePolicy=impact
controlMode=risky_only
timingPolicy=pre_action
notificationModality=mixed
interruptCooldownMs=3000
interruptTopK=10
explanationAvailability=full
explanationFormat=text
informationDensity=balanced
showPostHocPanel=true
```

3. Strict step-through audit
```text
gatePolicy=always
controlMode=step_through
timingPolicy=post_action
notificationModality=modal
interruptCooldownMs=0
interruptTopK=999
userActionOptions=extended
explanationAvailability=full
explanationFormat=diff
informationDensity=detailed
colorEncoding=high_contrast
```

### Phase 4: Oversight Design Metadata

- Registry descriptors include `interactionProperties`:
  - `interruptionLevel`
  - `oversightGranularity`
  - `feedbackLatency`
  - `agencyModel`
- Design taxonomy export utilities:
  - `src/oversight/design/exportDesignMatrix.ts`
  - supports JSON and CSV export formats
- Options page includes an `Export Design Matrix` button.

### Phase 5: Experiment Configuration DSL

- Experiment schema and validation:
  - `src/experiments/schema.ts`
- Experiment runner:
  - `src/experiments/runner.ts`
  - responsibilities:
    - load/parse config
    - apply mechanism + parameter setup
    - start session per task
    - execute task and collect telemetry

Minimal DSL example:

```ts
interface OversightExperimentConfig {
  mechanisms: string[];
  parameterOverrides: Record<string, any>;
  tasks: string[];
}
```

## Core Oversight Architecture

### 1. Oversight Event Contract

Shared event types are defined in `src/oversight/types.ts`.

```ts
export type OversightEvent =
  | { kind: 'tool_started'; ... }
  | { kind: 'run_completed'; ... }
  | { kind: 'run_cancelled'; ... }
  | { kind: 'run_failed'; ... };
```

Background publishes these events as runtime messages (`action: 'oversightEvent'`).

### 2. Mechanism Registry

Mechanisms are declared in `src/oversight/registry.ts`.

Each mechanism has:
- stable ID
- UI title + description
- storage key
- default enabled state
- optional legacy keys for migration compatibility

The options page reads this registry and renders toggles automatically.

### 3. Side Panel Mechanism Reducers

Side-panel mechanism logic lives in:
- `src/sidepanel/oversight/mechanismManager.ts`
- `src/sidepanel/hooks/useOversightMechanisms.ts`

Each mechanism is implemented as a reducer-like unit that consumes `OversightEvent` and updates UI state.

### 4. Background Oversight Manager

Background oversight integration is in `src/background/oversightManager.ts`.

It translates runtime lifecycle points (tool start, completion, cancellation, failure) into standardized `OversightEvent`s and handles optional overlays.

## Repository Structure

```text
public/                         Static extension assets (manifest/html/icons)
scripts/                        Build helper scripts
src/agent/                      Agent runtime, tools, execution engine
src/background/                 Service worker, tab management, oversight event emission
src/models/                     Model/provider adapters
src/options/                    Options UI (registry-driven mechanism toggles)
src/oversight/                  Shared oversight contracts and registry
src/experiments/                Experiment DSL schema and batch runner
src/sidepanel/                  Side panel UI + oversight mechanism reducers
src/tracking/                   Screenshot tracking utilities
```

## Requirements

- Node.js 18+ (Node 20+ recommended)
- npm
- Google Chrome (for loading unpacked extension)

## Install

```bash
npm install
```

## Run in Development

1. Start extension build watch:

```bash
npm run dev
```

2. Load extension in Chrome:
- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select the `dist/` directory

3. After code changes:
- Keep `npm run dev` running
- Click refresh on the extension card in `chrome://extensions`

Optional UI-only Vite server:

```bash
npm run dev:serve
```

## Build for Distribution

```bash
npm run build
```

This runs TypeScript compile + Vite build and copies static assets to `dist/`.

## Lint

```bash
npm run lint
npm run lint:fix
```

## Runtime E2E Verification

Run minimal Phase 3 runtime checks:

```bash
npm run test:e2e:runtime
```

Coverage includes:
- plan review blocking before execution
- pause/resume blocking behavior
- adaptive escalation authority transitions
- `oversightRhythmMetrics` export assertions

## Add a New Oversight Mechanism

This is the main extension point of the platform.

### Step 1: Register the mechanism

Edit `src/oversight/registry.ts`:
- add a new mechanism ID constant
- extend `OversightMechanismId` and `OversightMechanismSettings`
- add one entry to `OVERSIGHT_MECHANISM_REGISTRY`

Minimal example:

```ts
export const RISK_SCORE_MECHANISM_ID = 'risk-score' as const;

// add to OversightMechanismId and OversightMechanismSettings

OVERSIGHT_MECHANISM_REGISTRY.push({
  id: RISK_SCORE_MECHANISM_ID,
  title: 'Enable Risk Score',
  description: 'Show per-step risk scoring in the side panel.',
  storageKey: 'oversight.riskScore.enabled',
  defaultEnabled: true,
});
```

No manual options UI wiring is needed after this. The toggle is auto-rendered.

### Step 2: Extend the event contract (if needed)

If your mechanism needs new runtime signals, extend `OversightEvent` in `src/oversight/types.ts`.

Then emit the new event from background integration points (usually via `src/background/oversightManager.ts`).

### Step 3: Implement side-panel reducer logic

In `src/sidepanel/oversight/mechanismManager.ts`, add a mechanism reducer:

```ts
const riskScoreMechanism: OversightMechanism = {
  id: RISK_SCORE_MECHANISM_ID,
  reduce: (state, event, ctx) => {
    // transform oversight events into UI state
    return state;
  },
};
```

Add it to the `mechanisms` list.

### Step 4: Render mechanism UI (optional)

If the mechanism has visible UI, add component(s) under `src/sidepanel/components/` and render from `src/sidepanel/SidePanel.tsx` using state exposed by `useOversightMechanisms`.

### Step 5: Verify

```bash
npm run build
```

Then reload extension and test mechanism toggling in Options.

## Existing Integration Interfaces

### Background -> UI event message

`useChromeMessaging` expects:

```ts
{ action: 'oversightEvent', content: { event: OversightEvent }, tabId?, windowId? }
```

### Side-panel mechanism contract

Mechanisms follow this reducer contract in `mechanismManager.ts`:

```ts
interface OversightMechanism {
  id: OversightMechanismId;
  reduce: (state: OversightUiState, event: OversightEvent, ctx: OversightContext) => OversightUiState;
}
```

## Security Notes

This extension uses high-privilege capabilities (`debugger`, `tabs`, `activeTab`, broad host permissions) to automate real browser actions.

Use only in trusted environments and with trusted model/provider configuration.
