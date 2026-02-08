import type { Page } from "playwright-crx";

export type AttentionType = "selector" | "coordinates" | "url" | "text" | "none";

export interface AttentionTarget {
  type: AttentionType;
  label: string;
  selector?: string;
  x?: number;
  y?: number;
}

const TOOL_LABELS: Record<string, string> = {
  browser_click: "Click target",
  browser_type: "Type target",
  browser_fill: "Fill target",
  browser_query: "Query target",
  browser_snapshot_dom: "DOM focus area",
  browser_read_text: "Visible text read",
  browser_screenshot: "Screenshot area",
  browser_navigate: "Navigation target",
  browser_mouse_click: "Mouse click point",
  browser_mouse_move: "Mouse move point",
  browser_mouse_drag: "Mouse drag path",
};

function trimForDisplay(input: string, max = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function parseSelectorFromSnapshotInput(input: string): string | null {
  const match = input.match(/(?:^|,)\s*selector=(.*?)(?:,|$)/i);
  if (!match?.[1]) return null;
  return match[1].trim();
}

function parseCoordinates(input: string): { x: number; y: number } | null {
  const numberMatches = input.match(/-?\d+(\.\d+)?/g);
  if (!numberMatches || numberMatches.length < 2) return null;
  const x = Number(numberMatches[0]);
  const y = Number(numberMatches[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function inferAttentionTarget(toolName: string, toolInput: string): AttentionTarget {
  const cleanInput = (toolInput || "").trim();
  const toolLabel = TOOL_LABELS[toolName] || `Run ${toolName}`;

  if (!cleanInput) {
    return { type: "none", label: `${toolLabel} (no input)` };
  }

  if (toolName === "browser_type" || toolName === "browser_fill") {
    const selector = cleanInput.split("|")[0]?.trim();
    if (selector) {
      return {
        type: "selector",
        selector,
        label: `${toolLabel}: ${trimForDisplay(selector)}`,
      };
    }
  }

  if (
    toolName === "browser_click" ||
    toolName === "browser_query" ||
    toolName === "browser_snapshot_dom"
  ) {
    const selector =
      toolName === "browser_snapshot_dom"
        ? parseSelectorFromSnapshotInput(cleanInput)
        : cleanInput;

    if (selector) {
      return {
        type: "selector",
        selector,
        label: `${toolLabel}: ${trimForDisplay(selector)}`,
      };
    }
  }

  if (
    toolName === "browser_mouse_click" ||
    toolName === "browser_mouse_move" ||
    toolName === "browser_mouse_drag"
  ) {
    const coords = parseCoordinates(cleanInput);
    if (coords) {
      return {
        type: "coordinates",
        x: Math.round(coords.x),
        y: Math.round(coords.y),
        label: `${toolLabel}: (${Math.round(coords.x)}, ${Math.round(coords.y)})`,
      };
    }
  }

  if (toolName.includes("navigate")) {
    return {
      type: "url",
      label: `${toolLabel}: ${trimForDisplay(cleanInput)}`,
    };
  }

  return {
    type: "text",
    label: `${toolLabel}: ${trimForDisplay(cleanInput)}`,
  };
}

export async function clearAttentionOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const existing = document.getElementById("__intentguard_attention_overlay__");
    if (existing) existing.remove();
  });
}

export async function renderAttentionOverlay(page: Page, target: AttentionTarget): Promise<void> {
  if (target.type !== "selector" && target.type !== "coordinates") {
    await clearAttentionOverlay(page);
    return;
  }

  await page.evaluate((payload: AttentionTarget) => {
    const OVERLAY_ID = "__intentguard_attention_overlay__";
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483647";
    root.style.pointerEvents = "none";
    document.documentElement.appendChild(root);

    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.border = "2px solid #ef4444";
    box.style.boxShadow = "0 0 0 9999px rgba(239, 68, 68, 0.10)";
    box.style.borderRadius = "8px";
    box.style.pointerEvents = "none";
    root.appendChild(box);

    const badge = document.createElement("div");
    badge.textContent = "Agent Focus";
    badge.style.position = "fixed";
    badge.style.background = "#ef4444";
    badge.style.color = "#fff";
    badge.style.fontSize = "12px";
    badge.style.padding = "4px 8px";
    badge.style.borderRadius = "9999px";
    badge.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
    badge.style.pointerEvents = "none";
    root.appendChild(badge);

    if (payload.type === "selector" && payload.selector) {
      const element = document.querySelector(payload.selector);
      if (element) {
        const rect = element.getBoundingClientRect();
        box.style.left = `${Math.max(0, rect.left - 4)}px`;
        box.style.top = `${Math.max(0, rect.top - 4)}px`;
        box.style.width = `${Math.max(8, rect.width + 8)}px`;
        box.style.height = `${Math.max(8, rect.height + 8)}px`;
        badge.style.left = `${Math.max(8, rect.left)}px`;
        badge.style.top = `${Math.max(8, rect.top - 28)}px`;
      } else {
        box.remove();
        badge.textContent = "Agent Focus: selector not found";
        badge.style.left = "12px";
        badge.style.top = "12px";
      }
    } else if (payload.type === "coordinates") {
      const x = Math.max(0, Number(payload.x) || 0);
      const y = Math.max(0, Number(payload.y) || 0);
      box.style.left = `${Math.max(0, x - 14)}px`;
      box.style.top = `${Math.max(0, y - 14)}px`;
      box.style.width = "28px";
      box.style.height = "28px";
      box.style.borderRadius = "9999px";
      box.style.boxShadow = "0 0 0 9999px rgba(239, 68, 68, 0.08)";
      badge.style.left = `${Math.max(8, x + 16)}px`;
      badge.style.top = `${Math.max(8, y - 12)}px`;
    }

    setTimeout(() => {
      const current = document.getElementById(OVERLAY_ID);
      if (current) current.remove();
    }, 6000);
  }, target);
}
