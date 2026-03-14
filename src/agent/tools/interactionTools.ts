import { DynamicTool } from "langchain/tools";
import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { installDialogListener, lastDialog, resetDialog, withActivePage } from "./utils";

function normalizeTargetText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
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

async function clickWithViewportStability(
  activePage: Page,
  clickAction: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForViewportToSettle(activePage, 200, Math.min(2500, timeoutMs));
    try {
      await clickAction();
      return;
    } catch (error) {
      lastError = error;
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
  const handle = await locator.elementHandle();
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

async function clickLocatorConservatively(
  activePage: Page,
  locator: ReturnType<Page["locator"]>,
  timeoutMs: number,
  strictFocusAnchored = false
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
      timeoutMs
    );
    return;
  }

  await clickWithViewportStability(activePage, () => locator.click({ timeout: timeoutMs }), timeoutMs);
}

async function clickBestVisibleTextTarget(activePage: Page, target: string, timeoutMs: number): Promise<string> {
  const handle = await activePage.evaluateHandle((needle: string) => {
    function normalizeText(value: string): string {
      return value.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function isVisible(element: Element | null): element is HTMLElement {
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
        timeoutMs
      );
    } else {
      await clickWithViewportStability(activePage, () => elementHandle.click({ timeout: timeoutMs }), timeoutMs);
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
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const target = input.trim();
          if (!target) {
            return "Error: click target cannot be empty.";
          }

          // Keep click attempts bounded so missing/unstable targets do not stall the run.
          const CLICK_TIMEOUT_MS = 5000;

          if (/[#.[\]>:=]/.test(target)) {
            const locator = activePage.locator(target).first();
            const strictFocusAnchored = await hasStrictFocusAnchor(activePage, { type: "selector", selector: target });
            await clickLocatorConservatively(activePage, locator, CLICK_TIMEOUT_MS, strictFocusAnchored);
            return `Clicked selector: ${target}`;
          }

          return await clickBestVisibleTextTarget(activePage, target, CLICK_TIMEOUT_MS);
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
          const [selector, text] = input.split("|");
          if (!selector || !text) {
            return "Error: expected 'selector|text'";
          }
          await activePage.fill(selector, text);
          return `Typed "${text}" into ${selector}`;
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
