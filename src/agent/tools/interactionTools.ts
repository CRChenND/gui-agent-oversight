import { DynamicTool } from "langchain/tools";
import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { installDialogListener, lastDialog, resetDialog, withActivePage } from "./utils";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTargetText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isToolExecutionContext(value: unknown): value is { requiresApproval?: boolean } {
  return Boolean(value) && typeof value === "object" && "requiresApproval" in (value as Record<string, unknown>);
}

function extractQuotedText(value: string): string | null {
  const quoted = value.match(/["']([^"']+)["']/)?.[1]?.trim();
  return quoted || null;
}

function deriveTextTargetFromSelector(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  const containsMatch = trimmed.match(/:contains\((["'])(.*?)\1\)/i);
  if (containsMatch?.[2]?.trim()) {
    return containsMatch[2].trim();
  }

  const ariaMatch = trimmed.match(/\[aria-label[*^$|~]?=(["'])(.*?)\1\]/i);
  if (ariaMatch?.[2]?.trim()) {
    return ariaMatch[2].trim();
  }

  const titleMatch = trimmed.match(/\[title[*^$|~]?=(["'])(.*?)\1\]/i);
  if (titleMatch?.[2]?.trim()) {
    return titleMatch[2].trim();
  }

  const quoted = extractQuotedText(trimmed);
  if (quoted) return quoted;

  return null;
}

function shouldTreatAsSelector(target: string): boolean {
  if (!target.trim()) return false;
  if (/:contains\(/i.test(target)) return false;
  return /[#.[\]>:=]/.test(target);
}

async function clickByRoleOrText(
  activePage: Page,
  target: string,
  timeoutMs: number,
  showFocusOverlay = false,
  commitTarget?: { beforeUrl: string; target: string }
): Promise<string> {
  const roleCandidates = [
    activePage.getByRole("button", { name: target, exact: false }).first(),
    activePage.getByRole("link", { name: target, exact: false }).first(),
    activePage.getByRole("tab", { name: target, exact: false }).first(),
  ];

  for (const locator of roleCandidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 1200 });
      await clickLocatorConservatively(activePage, locator, timeoutMs, false, showFocusOverlay, commitTarget);
      return `Clicked role target: ${target}`;
    } catch {
      // Try next candidate.
    }
  }

  return clickBestVisibleTextTarget(activePage, target, timeoutMs, showFocusOverlay, commitTarget);
}

async function waitForViewportToSettle(activePage: Page, stableMs = 200, timeoutMs = 2500): Promise<void> {
  try {
    await activePage.evaluate(
      async ({ stableMs: stableWindowMs, timeoutMs: maxWaitMs }: { stableMs: number; timeoutMs: number }) => {
        const startedAt = Date.now();
        let lastMovedAt = startedAt;
        let lastX = window.scrollX;
        let lastY = window.scrollY;

        await new Promise<void>((resolve) => {
          const tick = () => {
            const nextX = window.scrollX;
            const nextY = window.scrollY;
            if (nextX !== lastX || nextY !== lastY) {
              lastX = nextX;
              lastY = nextY;
              lastMovedAt = Date.now();
            }

            const now = Date.now();
            if (now - lastMovedAt >= stableWindowMs || now - startedAt >= maxWaitMs) {
              resolve();
              return;
            }

            window.requestAnimationFrame(tick);
          };

          tick();
        });
      },
      { stableMs, timeoutMs }
    );
  } catch {
    // Best-effort only. Clicking should still proceed if stability detection fails.
  }
}

function safePageUrl(activePage: Page): string {
  try {
    return activePage.url();
  } catch {
    return "";
  }
}

function isLikelyPostClickCommitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /element is not attached|execution context was destroyed|target page, context or browser has been closed|frame was detached|navigation|page was closed/i.test(
    message
  );
}

async function isTargetStillPresent(activePage: Page, target: string): Promise<boolean> {
  const textTarget = deriveTextTargetFromSelector(target) || target;

  if (shouldTreatAsSelector(target)) {
    try {
      const count = await activePage.locator(target).count();
      if (count > 0) {
        return await activePage.locator(target).first().isVisible().catch(() => true);
      }
    } catch {
      // Fall through to text-based probing.
    }
  }

  try {
    const roleCandidates = [
      activePage.getByRole("button", { name: textTarget, exact: false }).first(),
      activePage.getByRole("link", { name: textTarget, exact: false }).first(),
      activePage.getByRole("tab", { name: textTarget, exact: false }).first(),
      activePage.getByText(textTarget, { exact: false }).first(),
    ];

    for (const locator of roleCandidates) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function didClickLikelyCommit(activePage: Page, target: string, beforeUrl: string, error: unknown): Promise<boolean> {
  if (!isLikelyPostClickCommitError(error)) {
    return false;
  }

  await Promise.race([
    activePage.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => undefined),
    wait(300),
  ]);

  const afterUrl = safePageUrl(activePage);
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
    return true;
  }

  return !(await isTargetStillPresent(activePage, target));
}

async function clickWithViewportStability(
  activePage: Page,
  clickAction: () => Promise<void>,
  timeoutMs: number,
  didCommitAfterError?: (error: unknown) => Promise<boolean>
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForViewportToSettle(activePage, 200, Math.min(2500, timeoutMs));
    try {
      await clickAction();
      return;
    } catch (error) {
      lastError = error;
      if (didCommitAfterError && (await didCommitAfterError(error))) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        /intercept|pointer events|not stable|another element|outside of the viewport|element is not attached/i.test(
          message
        );
      if (!retryable || attempt === 2) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fillLocatorConservatively(
  activePage: Page,
  locator: ReturnType<Page["locator"]>,
  text: string,
  timeoutMs: number
): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  await waitForViewportToSettle(activePage, 150, Math.min(1500, timeoutMs));

  try {
    await locator.fill(text, { timeout: timeoutMs });
    return;
  } catch {
    // Fall through to a more manual interaction path for flaky inputs.
  }

  await locator.click({ timeout: timeoutMs, noWaitAfter: true });
  await locator.press("Meta+A").catch(() => locator.press("Control+A").catch(() => undefined));
  await locator.fill("", { timeout: Math.min(timeoutMs, 2500) }).catch(() => undefined);
  await locator.type(text, { delay: 10, timeout: timeoutMs });
}

function buildInputCandidateLocators(activePage: Page, target: string): Array<ReturnType<Page["locator"]>> {
  const escaped = target.replace(/["\\]/g, "\\$&");
  const locators: Array<ReturnType<Page["locator"]>> = [];

  if (/[#.[\]>:=]/.test(target)) {
    locators.push(activePage.locator(target).first());
  }

  locators.push(activePage.getByLabel(target, { exact: false }).first());
  locators.push(activePage.getByPlaceholder(target, { exact: false }).first());
  locators.push(activePage.getByRole("textbox", { name: target, exact: false }).first());
  locators.push(
    activePage
      .locator(
        [
          `input[name="${escaped}"]`,
          `textarea[name="${escaped}"]`,
          `input[aria-label="${escaped}"]`,
          `textarea[aria-label="${escaped}"]`,
          `input[placeholder="${escaped}"]`,
          `textarea[placeholder="${escaped}"]`,
        ].join(", ")
      )
      .first()
  );

  return locators;
}

async function resolveInputLocator(
  activePage: Page,
  target: string,
  timeoutMs: number
): Promise<ReturnType<Page["locator"]>> {
  const candidates = buildInputCandidateLocators(activePage, target);
  let lastError: unknown;

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 2500) });
      return locator;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`No visible input matched target: ${target}`);
}

type ActionabilityProbe = {
  inViewport: boolean;
  centerX: number | null;
  centerY: number | null;
  unobscured: boolean;
};

async function hasStrictFocusAnchor(
  activePage: Page,
  target: { type: "selector"; selector: string } | { type: "text"; text: string }
): Promise<boolean> {
  try {
    return await activePage.evaluate(
      (payload: { type: "selector"; selector: string } | { type: "text"; text: string }) => {
        const anchor = (
          window as Window & {
            __morphFocusAnchor__?: { type?: string; selector?: string; text?: string };
          }
        ).__morphFocusAnchor__;
        if (!anchor || anchor.type !== payload.type) return false;
        if (payload.type === "selector") {
          return typeof anchor.selector === "string" && anchor.selector.trim() === payload.selector.trim();
        }
        const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
        return typeof anchor.text === "string" && normalize(anchor.text) === normalize(payload.text);
      },
      target
    );
  } catch {
    return false;
  }
}

async function probeLocatorActionability(locator: ReturnType<Page["locator"]>): Promise<ActionabilityProbe> {
  const handle = await Promise.race([
    locator.elementHandle(),
    wait(1200).then(() => {
      throw new Error("Timed out while resolving locator element handle.");
    }),
  ]);
  if (!handle) {
    return { inViewport: false, centerX: null, centerY: null, unobscured: false };
  }

  try {
    return await handle.evaluate((element: Element) => {
      if (!(element instanceof HTMLElement)) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }

      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      const inViewport = bottom > top && right > left;
      if (!inViewport) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }

      const centerX = left + (right - left) / 2;
      const centerY = top + (bottom - top) / 2;
      const topElement = document.elementFromPoint(centerX, centerY);
      const unobscured = Boolean(topElement && (topElement === element || element.contains(topElement)));
      return { inViewport, centerX, centerY, unobscured };
    });
  } finally {
    await handle.dispose();
  }
}

async function resolveClickableSelectorLocator(
  activePage: Page,
  target: string
): Promise<ReturnType<Page["locator"]>> {
  const locator = activePage.locator(target);
  const count = await Promise.race([
    locator.count(),
    wait(1200).then(() => {
      throw new Error(`Timed out while enumerating selector matches: ${target}`);
    }),
  ]);

  if (!count) {
    throw new Error(`No element matched selector: ${target}`);
  }

  let fallbackLocator: ReturnType<Page["locator"]> | null = null;
  const candidateCount = Math.min(count, 12);

  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = locator.nth(index);
    const probe = await probeLocatorActionability(candidate).catch(() => null);
    if (!probe) continue;
    if (!fallbackLocator && probe.inViewport) {
      fallbackLocator = candidate;
    }
    if (probe.inViewport && probe.unobscured && probe.centerX !== null && probe.centerY !== null) {
      return candidate;
    }
  }

  if (fallbackLocator) {
    return fallbackLocator;
  }

  return locator.first();
}

async function clickLocatorConservatively(
  activePage: Page,
  locator: ReturnType<Page["locator"]>,
  timeoutMs: number,
  strictFocusAnchored = false,
  showFocusOverlay = false,
  commitTarget?: { beforeUrl: string; target: string }
): Promise<void> {
  const initialProbe = await probeLocatorActionability(locator);
  if (strictFocusAnchored && !initialProbe.inViewport) {
    throw new Error("Strict focus target is outside the current viewport. Scrolling is forbidden for anchored agent focus.");
  }
  if (!initialProbe.inViewport) {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  }

  const readyProbe = initialProbe.inViewport ? initialProbe : await probeLocatorActionability(locator);
  if (strictFocusAnchored && (!readyProbe.inViewport || !readyProbe.unobscured || readyProbe.centerX === null || readyProbe.centerY === null)) {
    throw new Error("Strict focus target is not directly clickable in the current viewport. Scrolling retries are forbidden for anchored agent focus.");
  }
  if (readyProbe.inViewport && readyProbe.unobscured && readyProbe.centerX !== null && readyProbe.centerY !== null) {
    await clickWithViewportStability(
      activePage,
      () => activePage.mouse.click(readyProbe.centerX!, readyProbe.centerY!),
      timeoutMs,
      commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
    );
    return;
  }

  if (showFocusOverlay) {
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      await clickWithViewportStability(
        activePage,
        () => activePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
        timeoutMs,
        commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
      );
      return;
    }
  }
  await clickWithViewportStability(
    activePage,
    () => locator.click({ timeout: timeoutMs, noWaitAfter: true }),
    timeoutMs,
    commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
  );
}

async function clickBestVisibleTextTarget(
  activePage: Page,
  target: string,
  timeoutMs: number,
  showFocusOverlay = false,
  commitTarget?: { beforeUrl: string; target: string }
): Promise<string> {
  const handle = await activePage.evaluateHandle((needle: string) => {
    function normalizeText(value: string): string {
      return value.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function isInsideMorphOverlay(element: Element | null): boolean {
      return Boolean(element?.closest("#__morph_attention_overlay__"));
    }

    function isVisible(element: Element | null): element is HTMLElement {
      if (!(element instanceof HTMLElement)) return false;
      if (isInsideMorphOverlay(element)) return false;
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
      const candidate = (
        element.closest(
          "button, a, label, input, textarea, select, summary, [role='button'], [role='link'], [tabindex]"
        ) as HTMLElement | null
      ) || element;
      return isInsideMorphOverlay(candidate) ? element : candidate;
    }

    const normalizedNeedle = normalizeText(needle);
    if (!normalizedNeedle) return null;

    const visited = new Set<HTMLElement>();
    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, label, input, textarea, select, option, summary, [role='button'], [role='link'], [tabindex], span, div, p"
      )
    );

    let best: { element: HTMLElement; score: number } | null = null;

    for (const rawElement of candidates) {
      if (!(rawElement instanceof HTMLElement)) continue;
      const clickable = getClickableCandidate(rawElement);
      if (visited.has(clickable) || !isVisible(clickable)) continue;
      visited.add(clickable);

      const haystack = normalizeText(getElementText(clickable));
      if (!haystack || !haystack.includes(normalizedNeedle)) continue;

      const rect = clickable.getBoundingClientRect();
      let score = 0;
      if (haystack === normalizedNeedle) score += 120;
      if (haystack.startsWith(normalizedNeedle)) score += 45;
      if (haystack.includes(` ${normalizedNeedle} `)) score += 20;
      if (clickable !== rawElement) score += 18;
      if (clickable.matches("button, a, label, input, textarea, select, summary, [role='button'], [role='link']")) score += 30;
      score -= Math.max(0, haystack.length - normalizedNeedle.length);
      score -= Math.min(rect.width * rect.height, 200000) / 5000;
      score -= Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) / 200;

      if (!best || score > best.score) {
        best = { element: clickable, score };
      }
    }

    return best?.element ?? null;
  }, target);

  const elementHandle = handle.asElement();
  if (!elementHandle) {
    await handle.dispose();
    throw new Error(`No visible element matched text: ${target}`);
  }

  try {
    const strictFocusAnchored = await hasStrictFocusAnchor(activePage, { type: "text", text: target });
    const probe = await elementHandle.evaluate((element: Element) => {
      if (!(element instanceof HTMLElement)) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      const inViewport = bottom > top && right > left;
      if (!inViewport) {
        return { inViewport: false, centerX: null, centerY: null, unobscured: false };
      }
      const centerX = left + (right - left) / 2;
      const centerY = top + (bottom - top) / 2;
      const topElement = document.elementFromPoint(centerX, centerY);
      const unobscured = Boolean(topElement && (topElement === element || element.contains(topElement)));
      return { inViewport, centerX, centerY, unobscured };
    });

    if (strictFocusAnchored && (!probe.inViewport || !probe.unobscured || probe.centerX === null || probe.centerY === null)) {
      throw new Error("Strict focus target is not directly clickable in the current viewport. Scrolling retries are forbidden for anchored agent focus.");
    }

    if (probe.inViewport && probe.unobscured && probe.centerX !== null && probe.centerY !== null) {
      await clickWithViewportStability(
        activePage,
        () => activePage.mouse.click(probe.centerX!, probe.centerY!),
        timeoutMs,
        commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
      );
    } else {
      const box = await elementHandle.boundingBox().catch(() => null);
      if (box) {
        await clickWithViewportStability(
          activePage,
          () => activePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
          timeoutMs,
          commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
        );
        return `Clicked best visible text target: ${target}`;
      }
      await clickWithViewportStability(
        activePage,
        () => elementHandle.click({ timeout: timeoutMs, noWaitAfter: true }),
        timeoutMs,
        commitTarget ? (error) => didClickLikelyCommit(activePage, commitTarget.target, commitTarget.beforeUrl, error) : undefined
      );
    }
    return `Clicked best visible text target: ${target}`;
  } finally {
    await elementHandle.dispose();
  }
}

export const browserClick: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_click",
    description:
      "Click an element. Input may be a CSS selector or literal text to match on the page.",
    func: async (input: string, runtimeContext?: unknown) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const target = input.trim();
          if (!target) {
            return "Error: click target cannot be empty.";
          }
          const beforeUrl = safePageUrl(activePage);
          const showFocusOverlay = isToolExecutionContext(runtimeContext) && Boolean(runtimeContext.requiresApproval);

          try {
            // Keep click attempts bounded so missing/unstable targets do not stall the run.
            const CLICK_TIMEOUT_MS = 5000;

            const textTarget = deriveTextTargetFromSelector(target);

            if (shouldTreatAsSelector(target)) {
              try {
                const locator = await resolveClickableSelectorLocator(activePage, target);
                const strictFocusAnchored = await hasStrictFocusAnchor(activePage, { type: "selector", selector: target });
                await clickLocatorConservatively(
                  activePage,
                  locator,
                  CLICK_TIMEOUT_MS,
                  strictFocusAnchored,
                  showFocusOverlay,
                  { beforeUrl, target }
                );
                return `Clicked selector: ${target}`;
              } catch (selectorError) {
                if (!textTarget) {
                  throw selectorError;
                }
              }
            }

            return await clickByRoleOrText(
              activePage,
              textTarget || target,
              CLICK_TIMEOUT_MS,
              showFocusOverlay,
              { beforeUrl, target: textTarget || target }
            );
          } catch (error) {
            if (await didClickLikelyCommit(activePage, target, beforeUrl, error)) {
              return `Clicked target despite transient post-click error: ${target}`;
            }
            throw error;
          }
        });
      } catch (error) {
        return `Error clicking '${input}': ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserType: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_type",
    description:
      "Type text. Format: selector|text (e.g. input[name=\"q\"]|hello)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const separatorIndex = input.indexOf("|");
          const target = separatorIndex >= 0 ? input.slice(0, separatorIndex).trim() : "";
          const text = separatorIndex >= 0 ? input.slice(separatorIndex + 1) : "";
          if (!target || !text) {
            return "Error: expected 'selector|text'";
          }
          const TYPE_TIMEOUT_MS = 7000;
          const locator = await resolveInputLocator(activePage, target, TYPE_TIMEOUT_MS);
          await fillLocatorConservatively(activePage, locator, text, TYPE_TIMEOUT_MS);
          return `Typed "${text}" into ${target}`;
        });
      } catch (error) {
        return `Error typing into '${input}': ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserHandleDialog: ToolFactory = (page: Page) => {
  // Install dialog listener with the active page
  installDialogListener(page);

  return new DynamicTool({
    name: "browser_handle_dialog",
    description:
      "Accept or dismiss the most recent alert/confirm/prompt dialog.\n" +
      "Input `accept` or `dismiss`. For prompt dialogs you may append `|text` to supply response text.",
    func: async (input: string) => {
      try {
        if (!lastDialog)
          return "Error: no dialog is currently open or was detected.";
        const [action, text] = input.split("|").map(s => s.trim().toLowerCase());
        if (action !== "accept" && action !== "dismiss")
          return "Error: first part must be `accept` or `dismiss`.";
        if (action === "accept")
          await lastDialog.accept(text || undefined);
        else await lastDialog.dismiss();
        const type = lastDialog.type();
        resetDialog();
        return `${action === "accept" ? "Accepted" : "Dismissed"} ${type} dialog.`;
      } catch (err) {
        return `Error handling dialog: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });
};
