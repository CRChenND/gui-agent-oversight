import { DynamicTool } from "langchain/tools";
import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { installDialogListener, lastDialog, resetDialog, withActivePage } from "./utils";

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

async function isLocatorInViewport(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  const handle = await locator.elementHandle();
  if (!handle) return false;

  try {
    return await handle.evaluate((element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    });
  } finally {
    await handle.dispose();
  }
}

async function clickLocatorConservatively(
  activePage: Page,
  locator: ReturnType<Page["locator"]>,
  timeoutMs: number
): Promise<void> {
  const initiallyVisible = await isLocatorInViewport(locator);
  if (!initiallyVisible) {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
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
    await clickWithViewportStability(activePage, () => elementHandle.click({ timeout: timeoutMs }), timeoutMs);
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
            await clickLocatorConservatively(activePage, locator, CLICK_TIMEOUT_MS);
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
