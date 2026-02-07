import React from 'react';

interface OpenRouterSettingsProps {
  openrouterApiKey: string;
  setOpenrouterApiKey: (key: string) => void;
  openrouterBaseUrl: string;
  setOpenrouterBaseUrl: (url: string) => void;
  openrouterModelId: string;
  setOpenrouterModelId: (id: string) => void;
}

export function OpenRouterSettings({
  openrouterApiKey,
  setOpenrouterApiKey,
  openrouterBaseUrl,
  setOpenrouterBaseUrl,
  openrouterModelId,
  setOpenrouterModelId,
}: OpenRouterSettingsProps) {
  return (
    <div className="border rounded-lg p-4 mb-4">
      <h3 className="font-bold mb-2">OpenRouter Settings</h3>

      <div className="form-control mb-4">
        <label htmlFor="openrouter-api-key" className="label">
          <span className="label-text">API Key:</span>
        </label>
        <input
          type="password"
          id="openrouter-api-key"
          value={openrouterApiKey}
          onChange={(e) => setOpenrouterApiKey(e.target.value)}
          placeholder="Enter your OpenRouter API key (sk-or-v1-...)"
          className="input input-bordered w-full"
        />
      </div>

      <div className="form-control mb-4">
        <label htmlFor="openrouter-base-url" className="label">
          <span className="label-text">Base URL:</span>
        </label>
        <input
          type="text"
          id="openrouter-base-url"
          value={openrouterBaseUrl}
          onChange={(e) => setOpenrouterBaseUrl(e.target.value)}
          placeholder="https://openrouter.ai/api/v1"
          className="input input-bordered w-full"
        />
      </div>

      <div className="form-control mb-2">
        <label htmlFor="openrouter-model-id" className="label">
          <span className="label-text">Model ID:</span>
        </label>
        <input
          type="text"
          id="openrouter-model-id"
          value={openrouterModelId}
          onChange={(e) => setOpenrouterModelId(e.target.value)}
          placeholder="Enter OpenRouter model ID (e.g., openai/gpt-4o)"
          className="input input-bordered w-full"
        />
        <label className="label">
          <span className="label-text-alt">Use the exact model slug from OpenRouter’s models list.</span>
        </label>
      </div>
    </div>
  );
}

