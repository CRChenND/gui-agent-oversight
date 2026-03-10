# MORPH

MORPH is a Chrome Extension for studying and comparing oversight styles for browser agents.

Instead of treating oversight as a single toggle, MORPH packages the current implementation into four concrete oversight archetypes:

- `Risk-Gated Oversight`
- `Supervisory Co-Execution`
- `Action-Confirmation Oversight`
- `Structural Amplification`

The extension provides one shared browser-agent runtime, one side panel UI, and one configurable oversight layer. Each archetype is a different preset over the same runtime primitives.

## What MORPH Does

MORPH lets you:

- run browser tasks through a side panel chat interface
- execute the same task under different oversight archetypes
- compare how visibility, approval rhythm, and authority change the interaction
- inspect execution traces, plan state, and post-hoc telemetry
- switch between multiple model providers for the same task flow

The current extension name in [`public/manifest.json`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/public/manifest.json) is `MORPH`.

## The Four Oversight Archetypes

### 1. Risk-Gated Oversight

Best for: mostly autonomous execution with selective human checkpoints.

- The agent runs by default.
- Human review is requested only for higher-risk actions.
- Monitoring stays concise and selective.
- The interaction rhythm is episodic rather than continuous.

Current configuration:

- Agent focus: on
- Task graph: off
- Monitoring: on
- Intervention gate: on
- Adaptive controller: off
- Structural amplification: off

Core policy:

- `gatePolicy = impact`
- `controlMode = risky_only`
- `monitoringContentScope = standard`
- `explanationAvailability = summary`

Definition: [`src/options/oversightArchetypes/riskGated.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/riskGated.ts)

### 2. Supervisory Co-Execution

Best for: shared-control execution where the human stays in the loop throughout the run.

- The plan remains visible during execution.
- The human can inspect progress continuously in a persistent workspace.
- Monitoring is rich and persistent.
- The system is designed for collaborative steering rather than isolated approvals.

Current configuration:

- Agent focus: off
- Task graph: on
- Monitoring: on
- Intervention gate: off
- Adaptive controller: on
- Structural amplification: off

Core policy:

- full monitoring content
- full explanations in snippet form
- mixed notification modality
- no always-on approval gate

Definition: [`src/options/oversightArchetypes/supervisoryCoExecution.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/supervisoryCoExecution.ts)

### 3. Action-Confirmation Oversight

Best for: strict human approval before every action.

- The agent proposes its next move.
- The human must approve before execution continues.
- Oversight is intentionally minimal and interruptive.
- There is no risk classifier deciding when to ask.

Current configuration:

- Agent focus: off
- Task graph: off
- Monitoring: on
- Intervention gate: on
- Adaptive controller: off
- Structural amplification: off

Core policy:

- `gatePolicy = always`
- `controlMode = step_through`
- `timingPolicy = pre_action`
- `monitoringContentScope = minimal`
- `explanationAvailability = none`

Definition: [`src/options/oversightArchetypes/actionConfirmation.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/actionConfirmation.ts)

### 4. Structural Amplification

Best for: delegated execution that escalates into stronger oversight when the human starts inspecting, pausing, or intervening more actively.

- The agent begins in a relatively lightweight regime.
- Oversight becomes stronger when user behavior signals uncertainty or concern.
- Plan visibility and trace detail expand with the oversight regime.
- The runtime can insert soft pauses and deliberation scaffolds before actions.

Current configuration:

- Agent focus: on
- Task graph: on
- Monitoring: on
- Intervention gate: on
- Adaptive controller: off
- Structural amplification: on

Core policy:

- `gatePolicy = impact`
- `controlMode = risky_only`
- post-hoc panel enabled
- structural amplification enabled with behavior-driven escalation thresholds

Definition: [`src/options/oversightArchetypes/structuralAmplification.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/structuralAmplification.ts)

Default archetype:

- MORPH currently defaults to `Structural Amplification`
- Source: [`src/options/oversightArchetypes/index.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/index.ts)

## Shared Runtime Capabilities

All four archetypes run on top of the same extension runtime:

- side panel chat UI for task execution
- background controller for tab and session management
- runtime state for authority, phase, and execution status
- plan generation, review, approval, and in-run inspection
- approval requests and human intervention controls
- telemetry logging and JSON export
- multi-provider LLM configuration

This means archetypes are directly comparable because they reuse the same browser tools and execution engine.

## Mechanisms Behind the Archetypes

The current archetypes are built from six mechanism families:

- `agent-focus`
- `task-graph`
- `monitoring`
- `interventionGate`
- `adaptiveController`
- `structuralAmplification`

Registry source:

- [`src/oversight/registry.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/oversight/registry.ts)

Archetype composition source:

- [`src/options/oversightArchetypes/index.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/index.ts)

## Model Providers

MORPH currently supports:

- Anthropic
- OpenAI
- Gemini
- Ollama
- OpenAI-compatible endpoints
- OpenRouter

Provider configuration lives in the options UI and is persisted in Chrome storage.

## Development

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Watch Build

```bash
npm run dev
```

### Lint

```bash
npm run lint
```

### Runtime E2E Check

```bash
npm run test:e2e:runtime
```

## Load the Extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select the `dist` directory.

If you are iterating locally, rebuild after code changes and reload the unpacked extension in Chrome.

## Project Structure

- [`src/sidepanel`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/sidepanel): side panel UI and oversight presentation
- [`src/background`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/background): background service worker and runtime coordination
- [`src/agent`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/agent): execution engine and browser tools
- [`src/oversight`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/oversight): oversight registry, runtime, telemetry, and policy logic
- [`src/options`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options): options UI and archetype presets

## Extending the Archetypes

If you want to add or modify an archetype:

1. update or add a preset under [`src/options/oversightArchetypes`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes)
2. compose it from mechanism settings and parameter settings
3. register it in [`src/options/oversightArchetypes/index.ts`](/Users/chaoranchen/Documents/GitHub/gui-agent-oversight/src/options/oversightArchetypes/index.ts)

Because the archetypes are preset bundles over shared runtime components, adding a new archetype usually does not require changing the core execution engine.
