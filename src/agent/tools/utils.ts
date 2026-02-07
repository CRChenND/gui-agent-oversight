import type { Page, Dialog, BrowserContext } from "playwright-crx";
import { getCurrentPage } from "../PageContextManager";

/**
 * Helper function to get the current tab ID from a page
 * @param page The page to get the tab ID for
 * @returns Promise resolving to the tab ID or undefined if not found
 */
export async function getCurrentTabId(page: Page): Promise<number | undefined> {
  try {
    const pageUrl = page.url();

    // Prefer an exact URL match in the current window.
    const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });
    const exactMatch = currentWindowTabs.find(tab => tab.id && tab.url === pageUrl);
    if (exactMatch?.id) {
      return exactMatch.id;
    }

    // Fallback to global exact match if current window query misses.
    const allTabs = await chrome.tabs.query({});
    const globalExactMatch = allTabs.find(tab => tab.id && tab.url === pageUrl);
    if (globalExactMatch?.id) {
      return globalExactMatch.id;
    }
  } catch (error) {
    console.error("Error getting current tab ID:", error);
  }

  return undefined;
}

// Constants for output size limits
export const MAX_RETURN_CHARS = 20000;
export const MAX_SCREENSHOT_CHARS = 500000;

/**
 * Helper function to execute a function with the active page from PageContextManager
 * @param page The original page reference
 * @param fn The function to execute with the active page
 * @returns The result of the function
 */
export async function withActivePage<T>(
  page: Page,
  fn: (activePage: Page) => Promise<T>
): Promise<T> {
  const activePage = getCurrentPage(page);
  return fn(activePage);
}

/**
 * Truncate a string to a maximum length
 * @param str The string to truncate
 * @param maxLength The maximum length (default: MAX_RETURN_CHARS)
 * @returns The truncated string
 */
export function truncate(str: string, maxLength: number = MAX_RETURN_CHARS): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + `\n\n[Truncated ${str.length - maxLength} characters]`;
}

// Dialog handling
export let lastDialog: Dialog | null = null;
const dialogListenerInstalled = new WeakSet<Page>();
const dialogContextInstalled = new WeakSet<BrowserContext>();

export function resetDialog() {
  lastDialog = null;
}

export function installDialogListener(page: Page) {
  const context = page.context();

  const attachDialogListener = (targetPage: Page) => {
    if (dialogListenerInstalled.has(targetPage)) {
      return;
    }

    targetPage.on("dialog", dialog => {
      lastDialog = dialog;
    });
    dialogListenerInstalled.add(targetPage);
  };

  // Ensure the currently active page is covered.
  attachDialogListener(getCurrentPage(page));
  for (const contextPage of context.pages()) {
    attachDialogListener(contextPage);
  }

  // Hook future pages once per context.
  if (!dialogContextInstalled.has(context)) {
    context.on("page", attachDialogListener);
    dialogContextInstalled.add(context);
  }
}
