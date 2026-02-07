import { DynamicTool } from "langchain/tools";
import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { withActivePage } from "./utils";

function formatToolError(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

function parsePair(input: string): [number, number] | null {
  const [xRaw, yRaw] = input.split("|").map(s => s.trim());
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return null;
  }
  return [x, y];
}

function parseQuad(input: string): [number, number, number, number] | null {
  const values = input.split("|").map(s => Number(s.trim()));
  if (values.length !== 4 || values.some(v => Number.isNaN(v))) {
    return null;
  }
  return values as [number, number, number, number];
}

export const browserMoveMouse: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_move_mouse",
    description:
      "Move the mouse cursor to absolute screen coordinates.\n" +
      "Input format: `x|y`  (example: `250|380`)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const coords = parsePair(input);
          if (!coords) {
            return "Error: expected `x|y` numbers (e.g. 120|240)";
          }
          const [x, y] = coords;
          await activePage.mouse.move(x, y);
          return `Mouse moved to (${x}, ${y})`;
        });
      } catch (err) {
        return formatToolError("Error moving mouse", err);
      }
    },
  });

export const browserClickXY: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_click_xy",
    description:
      "Left‑click at absolute coordinates.\n" +
      "Input format: `x|y`  (example: `250|380`)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const coords = parsePair(input);
          if (!coords) {
            return "Error: expected `x|y` numbers (e.g. 120|240)";
          }
          const [x, y] = coords;
          await activePage.mouse.click(x, y);
          return `Clicked at (${x}, ${y})`;
        });
      } catch (err) {
        return formatToolError("Error clicking at coords", err);
      }
    },
  });

export const browserDrag: ToolFactory = (page: Page) =>
  new DynamicTool({
    name: "browser_drag",
    description:
      "Drag‑and‑drop with the left button.\n" +
      "Input format: `startX|startY|endX|endY`  (example: `100|200|300|400`)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const coords = parseQuad(input);
          if (!coords) {
            return "Error: expected `startX|startY|endX|endY` numbers";
          }
          const [sx, sy, ex, ey] = coords;
          await activePage.mouse.move(sx, sy);
          await activePage.mouse.down();
          await activePage.mouse.move(ex, ey);
          await activePage.mouse.up();
          return `Dragged (${sx},${sy}) → (${ex},${ey})`;
        });
      } catch (err) {
        return formatToolError("Error during drag", err);
      }
    },
  });
