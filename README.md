# GUI Agent Oversight Platform

`gui-agent-oversight` is a Chrome Extension (Manifest V3) for testing and comparing **oversight mechanisms** for GUI agents.

It now also serves as a **Programmable Oversight Interaction Research Platform** with a telemetry-first interaction layer.

It provides a shared runtime for browser automation plus a pluggable oversight layer, so you can:
- run the same agent tasks under different oversight policies
- turn mechanisms on/off from a registry-driven settings UI
- add new mechanisms with minimal changes to core agent code

The current extension name in `public/manifest.json` is `IntentGuard`.

## What This Platform Includes

- Side panel chat UI for prompt execution and streamed agent output
- Background controller for tab/session lifecycle and tool execution
- Oversight event pipeline between runtime and UI
- Registry-based oversight mechanism settings
- Optional approval flow for risky actions
- Interaction telemetry with session lifecycle and JSON export
- Parameterized oversight policies (per-mechanism configurable parameters)
- Design-space metadata for mechanisms and design matrix export
- Task graph step export (download current task steps as JSON)
- Experiment configuration DSL and runner for batch studies
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

### Phase 3: Oversight Design Metadata

- Registry descriptors include `interactionProperties`:
  - `interruptionLevel`
  - `oversightGranularity`
  - `feedbackLatency`
  - `agencyModel`
- Design taxonomy export utilities:
  - `src/oversight/design/exportDesignMatrix.ts`
  - supports JSON and CSV export formats
- Options page includes an `Export Design Matrix` button.

### Phase 4: Experiment Configuration DSL

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
