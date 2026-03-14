import { DynamicTool } from "langchain/tools";
import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { withActivePage } from "./utils";

type ScrollDirective = {
  deltaY: number;
  label: string;
};

function parseScrollInput(input: string): ScrollDirective | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return { deltaY: 700, label: "down" };
  }

  if (normalized === "down") return { deltaY: 700, label: "down" };
  if (normalized === "up") return { deltaY: -700, label: "up" };
  if (normalized === "page_down" || normalized === "pagedown") return { deltaY: 1100, label: "page_down" };
  if (normalized === "page_up" || normalized === "pageup") return { deltaY: -1100, label: "page_up" };

  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric !== 0) {
    return { deltaY: numeric, label: `${numeric}` };
  }

  return null;
}

export const browserScroll: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_scroll",
    description:
      "Scroll the current page vertically. Input may be `down`, `up`, `page_down`, `page_up`, or a pixel delta like `800` or `-600`.",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const directive = parseScrollInput(input);
          if (!directive) {
            return "Error: expected `down`, `up`, `page_down`, `page_up`, or a numeric pixel delta.";
          }

          const before = await activePage.evaluate(() => window.scrollY);
          const after = await activePage.evaluate((deltaY: number) => {
            window.scrollBy({ top: deltaY, behavior: "instant" });
            return window.scrollY;
          }, directive.deltaY);

          return `Scrolled ${directive.label}. ScrollY: ${before} -> ${after}`;
        });
      } catch (error) {
        return `Error scrolling '${input}': ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
