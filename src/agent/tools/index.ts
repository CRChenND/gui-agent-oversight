import type { Page } from "playwright-crx";
import { browserClick, browserType, browserHandleDialog } from "./interactionTools";
import { browserPressKey, browserKeyboardType } from "./keyboardTools";
import { browserMoveMouse, browserClickXY, browserDrag } from "./mouseTools";
import { browserNavigate, browserWaitForNavigation, browserNavigateBack, browserNavigateForward } from "./navigationTools";
import { browserGetTitle, browserSnapshotDom, browserQuery, browserAccessibleTree, browserReadText, browserScreenshot } from "./observationTools";
import {
  browserGetActiveTab,
  browserNavigateTab,
  browserScreenshotTab
} from "./tabContextTools";
import { browserTabList, browserTabNew, browserTabSelect, browserTabClose } from "./tabTools";
import type { ToolFactory } from "./types";

type AnyToolFactory = ToolFactory | ((page: Page) => unknown);

const navigationToolFactories: AnyToolFactory[] = [
  browserNavigate,
  browserWaitForNavigation,
  browserNavigateBack,
  browserNavigateForward
];

const tabContextToolFactories: AnyToolFactory[] = [
  browserGetActiveTab,
  browserNavigateTab,
  browserScreenshotTab
];

const interactionToolFactories: AnyToolFactory[] = [browserClick, browserType, browserHandleDialog];
const observationToolFactories: AnyToolFactory[] = [
  browserGetTitle,
  browserSnapshotDom,
  browserQuery,
  browserAccessibleTree,
  browserReadText,
  browserScreenshot
];
const mouseToolFactories: AnyToolFactory[] = [browserMoveMouse, browserClickXY, browserDrag];
const keyboardToolFactories: AnyToolFactory[] = [browserPressKey, browserKeyboardType];
const tabToolFactories: AnyToolFactory[] = [browserTabList, browserTabNew, browserTabSelect, browserTabClose];

const allToolFactories: AnyToolFactory[] = [
  ...navigationToolFactories,
  ...tabContextToolFactories,
  ...interactionToolFactories,
  ...observationToolFactories,
  ...mouseToolFactories,
  ...keyboardToolFactories,
  ...tabToolFactories
];

// Export all tools
export {
  // Navigation tools
  browserNavigate,
  browserWaitForNavigation,
  browserNavigateBack,
  browserNavigateForward,
  
  // Tab context tools
  browserGetActiveTab,
  browserNavigateTab,
  browserScreenshotTab,
  
  // Interaction tools
  browserClick,
  browserType,
  browserHandleDialog,
  
  // Observation tools
  browserGetTitle,
  browserSnapshotDom,
  browserQuery,
  browserAccessibleTree,
  browserReadText,
  browserScreenshot,
  
  // Mouse tools
  browserMoveMouse,
  browserClickXY,
  browserDrag,
  
  // Keyboard tools
  browserPressKey,
  browserKeyboardType,
  
  // Tab tools
  browserTabList,
  browserTabNew,
  browserTabSelect,
  browserTabClose
};

// Function to get all tools as an array
export function getAllTools(page: Page) {
  return allToolFactories.map(createTool => createTool(page));
}
