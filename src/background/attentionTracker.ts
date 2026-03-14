import type { Page } from "playwright-crx";
import { wait } from "./utils";

export type AttentionType = "selector" | "coordinates" | "url" | "text" | "none";

export interface AttentionTarget {
  type: AttentionType;
  label: string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  thinking?: string;
  approval?: {
    requestId: string;
    tabId?: number;
    windowId?: number;
    title: string;
    message: string;
    approveLabel?: string;
    approveSeriesLabel?: string;
    rejectLabel?: string;
  };
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
  browser_click_xy: "Mouse click point",
  browser_move_mouse: "Mouse move point",
  browser_drag: "Mouse drag path",
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
  const parts = input.split("|").map((part) => part.trim()).filter(Boolean);
  const numberMatches = parts.length >= 2 ? parts : input.match(/-?\d+(\.\d+)?/g) || [];
  if (numberMatches.length < 2) return null;
  const x = Number(numberMatches[numberMatches.length >= 4 ? numberMatches.length - 2 : 0]);
  const y = Number(numberMatches[numberMatches.length >= 4 ? numberMatches.length - 1 : 1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function looksLikeSelector(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/^[.#\[]/.test(trimmed)) return true;
  if (/[>:[\]=]/.test(trimmed)) return true;
  if (/^(input|button|a|div|span|textarea|select|label|form|main|section|article|nav|header|footer)\b/i.test(trimmed)) {
    return true;
  }
  return false;
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

  if (toolName === "browser_click") {
    if (looksLikeSelector(cleanInput)) {
      return {
        type: "selector",
        selector: cleanInput,
        label: `${toolLabel}: ${trimForDisplay(cleanInput)}`,
      };
    }

    return {
      type: "text",
      text: cleanInput,
      label: `${toolLabel}: ${trimForDisplay(cleanInput)}`,
    };
  }

  if (
    toolName === "browser_mouse_click" ||
    toolName === "browser_mouse_move" ||
    toolName === "browser_mouse_drag" ||
    toolName === "browser_click_xy" ||
    toolName === "browser_move_mouse" ||
    toolName === "browser_drag"
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
    delete (
      window as Window & {
        __morphFocusAnchor__?: unknown;
      }
    ).__morphFocusAnchor__;
    const existing = document.getElementById("__morph_attention_overlay__");
    if (existing) {
      (
        existing as HTMLElement & {
          __morphCleanupAttentionOverlay__?: () => void;
        }
      ).__morphCleanupAttentionOverlay__?.();
      existing.remove();
    }
  });
}

export async function canAnchorAttentionTargetInViewport(page: Page, target: AttentionTarget): Promise<boolean> {
  if (target.type === "coordinates") {
    return (
      typeof target.x === "number" &&
      typeof target.y === "number" &&
      target.x >= 0 &&
      target.y >= 0 &&
      target.x <= 100000 &&
      target.y <= 100000
    );
  }

  if (target.type !== "selector" && target.type !== "text") {
    return false;
  }

  try {
    return await page.evaluate((payload: AttentionTarget) => {
      function isVisibleInViewport(element: Element | null): boolean {
        if (!element) return false;
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
      }

      function resolveVisibleTextTarget(text: string): Element | null {
        function normalizeText(value: string): string {
          return value.replace(/\s+/g, " ").trim().toLowerCase();
        }

        function isVisibleCandidate(element: Element | null): element is HTMLElement {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) return false;
          const style = window.getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") return false;
          return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
        }

        function getElementText(element: HTMLElement): string {
          const pieces = [
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            (element as HTMLInputElement).value,
          ];
          return pieces.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
        }

        function getClickableCandidate(element: HTMLElement): HTMLElement {
          return (
            element.closest(
              "button, a, label, input, textarea, select, summary, [role='button'], [role='link'], [tabindex]"
            ) as HTMLElement | null
          ) || element;
        }

        const needle = normalizeText(text);
        if (!needle) return null;

        const elements = Array.from(
          document.querySelectorAll(
            "button, a, label, input, textarea, select, option, summary, [role='button'], [role='link'], [tabindex], span, div, p"
          )
        );
        const visited = new Set<HTMLElement>();
        let best: { element: HTMLElement; score: number } | null = null;

        for (const rawElement of elements) {
          if (!(rawElement instanceof HTMLElement)) continue;
          const element = getClickableCandidate(rawElement);
          if (visited.has(element) || !isVisibleCandidate(element)) continue;
          visited.add(element);

          const haystack = normalizeText(getElementText(element));
          if (!haystack || !haystack.includes(needle)) continue;

          const rect = element.getBoundingClientRect();
          let score = 0;
          if (haystack === needle) score += 120;
          if (haystack.startsWith(needle)) score += 45;
          if (haystack.includes(` ${needle} `)) score += 20;
          if (element !== rawElement) score += 18;
          if (element.matches("button, a, label, input, textarea, select, summary, [role='button'], [role='link']")) score += 30;
          score -= Math.max(0, haystack.length - needle.length);
          score -= Math.min(rect.width * rect.height, 200000) / 5000;
          score -= Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) / 200;

          if (!best || score > best.score) {
            best = { element, score };
          }
        }

        return best?.element ?? null;
      }

      if (payload.type === "selector" && payload.selector) {
        try {
          return isVisibleInViewport(document.querySelector(payload.selector));
        } catch {
          return false;
        }
      }

      if (payload.type === "text" && payload.text) {
        return isVisibleInViewport(resolveVisibleTextTarget(payload.text));
      }

      return false;
    }, target);
  } catch {
    return false;
  }
}

export async function renderAttentionOverlay(page: Page, target: AttentionTarget): Promise<void> {
  if (
    target.type !== "selector" &&
    target.type !== "coordinates" &&
    target.type !== "text" &&
    !target.thinking &&
    !target.approval
  ) {
    await clearAttentionOverlay(page);
    return;
  }

  await page.evaluate((payload: AttentionTarget) => {
    (
      window as Window & {
        __morphFocusAnchor__?: AttentionTarget;
      }
    ).__morphFocusAnchor__ = payload;

    const OVERLAY_ID = "__morph_attention_overlay__";
    const renderToken = `overlay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const old = document.getElementById(OVERLAY_ID);
    if (old) {
      (
        old as HTMLElement & {
          __morphCleanupAttentionOverlay__?: () => void;
        }
      ).__morphCleanupAttentionOverlay__?.();
      old.remove();
    }

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.setAttribute("data-render-token", renderToken);
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483647";
    root.style.pointerEvents = "auto";
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

    const cardStack = document.createElement("div");
    cardStack.style.position = "fixed";
    cardStack.style.display = "flex";
    cardStack.style.flexDirection = "column";
    cardStack.style.gap = "10px";
    cardStack.style.pointerEvents = "auto";
    root.appendChild(cardStack);

    const sharedCardStyles = (card: HTMLDivElement) => {
      card.style.maxWidth = "min(320px, calc(100vw - 24px))";
      card.style.minWidth = "220px";
      card.style.background = "linear-gradient(180deg, rgba(17, 24, 39, 0.96) 0%, rgba(31, 41, 55, 0.96) 100%)";
      card.style.color = "#f9fafb";
      card.style.border = "1px solid rgba(251, 113, 133, 0.28)";
      card.style.borderRadius = "16px";
      card.style.padding = "12px 14px";
      card.style.boxShadow = "0 18px 44px rgba(15, 23, 42, 0.34)";
      card.style.fontSize = "12px";
      card.style.lineHeight = "1.5";
      card.style.fontFamily =
        "ui-rounded, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    };

    const thinkingCard = payload.thinking
      ? (() => {
          const card = document.createElement("div");
          sharedCardStyles(card);

          const title = document.createElement("div");
          title.textContent = "Thinking";
          title.style.fontSize = "10px";
          title.style.fontWeight = "700";
          title.style.letterSpacing = "0.08em";
          title.style.textTransform = "uppercase";
          title.style.color = "rgba(248, 113, 113, 0.95)";
          title.style.marginBottom = "6px";
          card.appendChild(title);

          const body = document.createElement("div");
          card.appendChild(body);
          cardStack.appendChild(card);

          const text = payload.thinking ?? "";
          let index = 0;
          const timer = window.setInterval(() => {
            index = Math.min(text.length, index + 2);
            body.textContent = text.slice(0, index);
            if (index >= text.length) {
              window.clearInterval(timer);
            }
          }, 18);

          return card;
        })()
      : null;

    const approvalCard = payload.approval
      ? (() => {
          const card = document.createElement("div");
          sharedCardStyles(card);
          card.style.pointerEvents = "auto";
          card.style.border = "1px solid rgba(251, 191, 36, 0.30)";
          card.style.background =
            "linear-gradient(180deg, rgba(17, 24, 39, 0.98) 0%, rgba(55, 65, 81, 0.98) 100%)";

          const eyebrow = document.createElement("div");
          eyebrow.textContent = "Needs Your Decision";
          eyebrow.style.fontSize = "10px";
          eyebrow.style.fontWeight = "700";
          eyebrow.style.letterSpacing = "0.08em";
          eyebrow.style.textTransform = "uppercase";
          eyebrow.style.color = "rgba(253, 224, 71, 0.95)";
          eyebrow.style.marginBottom = "6px";
          card.appendChild(eyebrow);

          const title = document.createElement("div");
          title.textContent = payload.approval.title;
          title.style.fontSize = "15px";
          title.style.fontWeight = "700";
          title.style.lineHeight = "1.3";
          title.style.marginBottom = "8px";
          card.appendChild(title);

          const body = document.createElement("div");
          body.textContent = payload.approval.message;
          body.style.color = "rgba(255, 255, 255, 0.88)";
          body.style.fontSize = "12px";
          body.style.lineHeight = "1.5";
          body.style.maxHeight = "132px";
          body.style.overflowY = "auto";
          body.style.paddingRight = "2px";
          card.appendChild(body);

          const actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.flexWrap = "wrap";
          actions.style.justifyContent = "stretch";
          actions.style.gap = "8px";
          actions.style.marginTop = "12px";

          const rejectButton = document.createElement("button");
          rejectButton.textContent = payload.approval.rejectLabel || "Reject";
          rejectButton.style.border = "none";
          rejectButton.style.background = "linear-gradient(135deg, #fb7185 0%, #e11d48 100%)";
          rejectButton.style.color = "#fff";
          rejectButton.style.borderRadius = "9999px";
          rejectButton.style.padding = "7px 12px";
          rejectButton.style.fontSize = "12px";
          rejectButton.style.fontWeight = "700";
          rejectButton.style.cursor = "pointer";
          rejectButton.style.boxShadow = "0 8px 18px rgba(225, 29, 72, 0.28)";
          rejectButton.style.flex = "1 1 92px";

          const approveButton = document.createElement("button");
          approveButton.textContent = payload.approval.approveLabel || "Approve";
          approveButton.style.border = "none";
          approveButton.style.background = "linear-gradient(135deg, #34d399 0%, #16a34a 100%)";
          approveButton.style.color = "#fff";
          approveButton.style.borderRadius = "9999px";
          approveButton.style.padding = "7px 14px";
          approveButton.style.fontSize = "12px";
          approveButton.style.fontWeight = "700";
          approveButton.style.cursor = "pointer";
          approveButton.style.boxShadow = "0 8px 18px rgba(22, 163, 74, 0.28)";
          approveButton.style.flex = "1 1 92px";

          const approveSeriesButton = document.createElement("button");
          approveSeriesButton.textContent = payload.approval.approveSeriesLabel || "Approve Similar";
          approveSeriesButton.style.border = "1px solid rgba(45, 212, 191, 0.35)";
          approveSeriesButton.style.background = "rgba(20, 184, 166, 0.16)";
          approveSeriesButton.style.color = "#ccfbf1";
          approveSeriesButton.style.borderRadius = "9999px";
          approveSeriesButton.style.padding = "7px 12px";
          approveSeriesButton.style.fontSize = "12px";
          approveSeriesButton.style.fontWeight = "700";
          approveSeriesButton.style.cursor = "pointer";
          approveSeriesButton.style.flex = "1 1 120px";

          const setPendingState = () => {
            rejectButton.disabled = true;
            approveButton.disabled = true;
            approveSeriesButton.disabled = true;
            rejectButton.style.opacity = "0.65";
            approveButton.style.opacity = "0.65";
            approveSeriesButton.style.opacity = "0.65";
            rejectButton.style.cursor = "default";
            approveButton.style.cursor = "default";
            approveSeriesButton.style.cursor = "default";
          };

          const submitDecision = (approved: boolean, approvalMode: "once" | "series" = "once") => {
            setPendingState();
            (window as Window & {
              __morphApprovalDecision__?: {
                requestId: string;
                approved: boolean;
                approvalMode?: "once" | "series";
                tabId?: number;
                windowId?: number;
                at: number;
              };
            }).__morphApprovalDecision__ = {
              requestId: payload.approval!.requestId,
              approved,
              approvalMode,
              tabId: payload.approval!.tabId,
              windowId: payload.approval!.windowId,
              at: Date.now(),
            };
            root.remove();
          };

          rejectButton.addEventListener("click", () => submitDecision(false, "once"));
          approveButton.addEventListener("click", () => submitDecision(true, "once"));
          approveSeriesButton.addEventListener("click", () => submitDecision(true, "series"));

          actions.appendChild(rejectButton);
          actions.appendChild(approveSeriesButton);
          actions.appendChild(approveButton);
          card.appendChild(actions);
          cardStack.appendChild(card);
          return card;
        })()
      : null;

    let repositionScheduled = false;
    let pollingTimer: number | null = null;

    function placeCardStack(anchorRect: DOMRect | { left: number; top: number; width: number; height: number }) {
      if (!thinkingCard && !approvalCard) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const cardWidth = Math.min(320, Math.max(180, viewportWidth * 0.28));
      cardStack.style.width = `${cardWidth}px`;

      let left = anchorRect.left + anchorRect.width + 14;
      if (left + cardWidth > viewportWidth - 12) {
        left = Math.max(12, anchorRect.left - cardWidth - 14);
      }

      const estimatedHeight = approvalCard ? 320 : 132;
      let top = anchorRect.top + anchorRect.height + 10;
      if (top + estimatedHeight > viewportHeight - 12) {
        top = Math.max(12, anchorRect.top + anchorRect.height - estimatedHeight);
      }
      if (top + estimatedHeight > viewportHeight - 12) {
        top = Math.max(12, viewportHeight - estimatedHeight - 12);
      }

      cardStack.style.left = `${left}px`;
      cardStack.style.top = `${top}px`;
    }

    function showFallbackCards() {
      box.remove();
      badge.remove();
      placeCardStack({ left: 12, top: 44, width: 0, height: 0 });
    }

    function applyRect(rect: DOMRect | { left: number; top: number; width: number; height: number }) {
      if (!box.isConnected) root.appendChild(box);
      if (!badge.isConnected) root.appendChild(badge);
      box.style.left = `${Math.max(0, rect.left - 4)}px`;
      box.style.top = `${Math.max(0, rect.top - 4)}px`;
      box.style.width = `${Math.max(8, rect.width + 8)}px`;
      box.style.height = `${Math.max(8, rect.height + 8)}px`;
      box.style.borderRadius = "8px";
      box.style.boxShadow = "0 0 0 9999px rgba(239, 68, 68, 0.10)";
      badge.style.left = `${Math.max(8, rect.left)}px`;
      badge.style.top = `${Math.max(8, rect.top - 28)}px`;
      placeCardStack(rect);
    }

    function resolveVisibleTextTarget(text: string): Element | null {
      function normalizeText(value: string): string {
        return value.replace(/\s+/g, " ").trim().toLowerCase();
      }

      function isVisibleCandidate(element: Element | null): element is HTMLElement {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
      }

      function getElementText(element: HTMLElement): string {
        const pieces = [
          element.innerText,
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("placeholder"),
          (element as HTMLInputElement).value,
        ];
        return pieces.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
      }

      function getClickableCandidate(element: HTMLElement): HTMLElement {
        return (
          element.closest(
            "button, a, label, input, textarea, select, summary, [role='button'], [role='link'], [tabindex]"
          ) as HTMLElement | null
        ) || element;
      }

      const needle = normalizeText(text);
      if (!needle) return null;

      const elements = Array.from(
        document.querySelectorAll(
          "button, a, label, input, textarea, select, option, summary, [role='button'], [role='link'], [tabindex], span, div, p"
        )
      );
      const visited = new Set<HTMLElement>();
      let best: { element: HTMLElement; score: number } | null = null;

      for (const rawElement of elements) {
        if (!(rawElement instanceof HTMLElement)) continue;
        const element = getClickableCandidate(rawElement);
        if (visited.has(element) || !isVisibleCandidate(element)) continue;
        visited.add(element);

        const haystack = normalizeText(getElementText(element));
        if (!haystack || !haystack.includes(needle)) continue;

        const rect = element.getBoundingClientRect();
        let score = 0;
        if (haystack === needle) score += 120;
        if (haystack.startsWith(needle)) score += 45;
        if (haystack.includes(` ${needle} `)) score += 20;
        if (element !== rawElement) score += 18;
        if (element.matches("button, a, label, input, textarea, select, summary, [role='button'], [role='link']")) score += 30;
        score -= Math.max(0, haystack.length - needle.length);
        score -= Math.min(rect.width * rect.height, 200000) / 5000;
        score -= Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) / 200;

        if (!best || score > best.score) {
          best = { element, score };
        }
      }

      return best?.element ?? null;
    }

    function updateOverlayPosition() {
      if (payload.type === "selector" && payload.selector) {
        let element: Element | null = null;
        try {
          element = document.querySelector(payload.selector);
        } catch {
          element = null;
        }

        if (element instanceof HTMLElement) {
          applyRect(element.getBoundingClientRect());
        } else {
          showFallbackCards();
        }
        return;
      }

      if (payload.type === "text" && payload.text) {
        const element = resolveVisibleTextTarget(payload.text);
        if (element instanceof HTMLElement) {
          applyRect(element.getBoundingClientRect());
        } else {
          showFallbackCards();
        }
        return;
      }

      if (payload.type === "coordinates") {
        if (!box.isConnected) root.appendChild(box);
        if (!badge.isConnected) root.appendChild(badge);
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
        placeCardStack({ left: x + 16, top: y - 12, width: 0, height: 0 });
        return;
      }

      showFallbackCards();
    }

    function scheduleReposition() {
      if (repositionScheduled) return;
      repositionScheduled = true;
      window.requestAnimationFrame(() => {
        repositionScheduled = false;
        updateOverlayPosition();
      });
    }

    updateOverlayPosition();

    const scrollListenerOptions = { passive: true, capture: true } as const;
    const onViewportChanged = () => scheduleReposition();
    window.addEventListener("scroll", onViewportChanged, scrollListenerOptions);
    window.addEventListener("resize", onViewportChanged);
    if (payload.type === "selector" || payload.type === "text") {
      pollingTimer = window.setInterval(() => {
        updateOverlayPosition();
      }, 150);
    }
    (
      root as HTMLElement & {
        __morphCleanupAttentionOverlay__?: () => void;
      }
    ).__morphCleanupAttentionOverlay__ = () => {
      window.removeEventListener("scroll", onViewportChanged, scrollListenerOptions);
      window.removeEventListener("resize", onViewportChanged);
      if (pollingTimer !== null) {
        window.clearInterval(pollingTimer);
      }
    };

    if (!payload.approval) {
      setTimeout(() => {
        const current = document.getElementById(OVERLAY_ID);
        if (current?.getAttribute("data-render-token") === renderToken) {
          (
            current as HTMLElement & {
              __morphCleanupAttentionOverlay__?: () => void;
            }
          ).__morphCleanupAttentionOverlay__?.();
          current.remove();
        }
      }, 6000);
    }
  }, target);
}

export async function waitForOverlayApprovalDecision(
  page: Page,
  requestId: string,
  timeoutMs = 5 * 60 * 1000
): Promise<{ requestId: string; approved: boolean; approvalMode?: 'once' | 'series'; tabId?: number; windowId?: number } | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await page.evaluate<
        { requestId: string; approved: boolean; approvalMode?: 'once' | 'series'; tabId?: number; windowId?: number } | null,
        string
      >((targetRequestId: string) => {
        const decision = (window as Window & {
          __morphApprovalDecision__?: {
            requestId: string;
            approved: boolean;
            approvalMode?: 'once' | 'series';
            tabId?: number;
            windowId?: number;
          };
        }).__morphApprovalDecision__;

        if (!decision || decision.requestId !== targetRequestId) {
          return null;
        }

        delete (window as Window & { __morphApprovalDecision__?: unknown }).__morphApprovalDecision__;
        return decision;
      }, requestId);

      if (payload) {
        return payload;
      }
    } catch {
      return null;
    }

    await wait(200);
  }

  return null;
}
