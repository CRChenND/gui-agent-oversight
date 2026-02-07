# gui-agent-oversight

Browser extension for natural-language browser automation with human oversight.

This project builds a Chrome Extension (Manifest V3) with:
- a side panel chat UI
- an options page for provider/config management
- a background agent controller that executes browser tools
- optional approval flow for sensitive actions

The extension name in `manifest.json` is currently `IntentGuard`.

## Features

- Natural language browser control through tool execution
- Multiple model provider support (Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible endpoints, OpenRouter)
- Side panel workflow for prompt, streaming output, screenshots, and status
- Tab-aware automation and recovery logic when debug sessions are detached
- Optional approval requests before executing risky actions

## Tech Stack

- TypeScript
- React
- Vite
- Tailwind CSS + DaisyUI
- `playwright-crx` for browser automation integration
- Chrome Extension APIs (MV3)

## Requirements

- Node.js 18+ (Node 20+ recommended)
- npm
- Google Chrome (for loading unpacked extension)

## Installation

```bash
npm install
```

## Development

Start watch build:

```bash
npm run dev
```

This writes extension artifacts to `dist/` and keeps rebuilding on file changes.

In Chrome:
1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `dist/` folder
5. Click refresh on the extension card after rebuilds

Optional UI-only dev server:

```bash
npm run dev:serve
```

## Build

```bash
npm run build
```

Build output is generated in `dist/`, including copied static files from `public/`.

## Lint

```bash
npm run lint
npm run lint:fix
```

## Project Structure

```text
public/                 Extension static assets (manifest, html, icons)
scripts/                Build helper scripts
src/background/         MV3 service worker, message routing, tab/session lifecycle
src/agent/              Agent runtime, execution engine, tools, prompt/global-knowledge management
src/sidepanel/          Side panel React UI
src/options/            Options page React UI
src/models/             Provider adapters and model definitions
src/tracking/           Screenshot tracking utilities
```

## Provider Configuration

Open the extension options page and configure your provider credentials/model settings.

On first install, options may open automatically. You can also open options from the extension page.

## Security and Permissions

This extension requests high-privilege permissions (`debugger`, `tabs`, `activeTab`, host permissions on all URLs) to automate browser actions.

Review permissions and run only in trusted environments.

## License

See `LICENSE`.
