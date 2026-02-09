import { BrowserTool } from "./tools/types";

/**
 * PromptManager handles system prompt generation and prompt templates.
 */
export class PromptManager {
  private tools: BrowserTool[];
  private globalKnowledgeText: string = "";
  
  constructor(tools: BrowserTool[]) {
    this.tools = tools;
  }
  
  // Store the current page context
  private currentPageContext: string = "";
  
  /**
   * Set the current page context
   */
  setCurrentPageContext(url: string, title: string): void {
    this.currentPageContext = `You are currently on ${url} (${title}).
    
If the user's request seems to continue a previous task (like asking to "summarize options" after a search), interpret it in the context of what you've just been doing.

If the request seems to start a new task that requires going to a different website, you should navigate there.

Use your judgment to determine whether the request is meant to be performed on the current page or requires navigation elsewhere.

Remember to follow the verification-first workflow: navigate → observe → analyze → act`;
  }
  
  /**
   * Build the fixed system prompt for the agent.
   */
  getSystemPrompt(): string {
    const toolDescriptions = this.tools
      .map(t => `${t.name}: ${t.description}`)
      .join("\n\n");
    
    // Include the current page context if available
    const pageContextSection = this.currentPageContext ? 
      `\n\n## CURRENT PAGE CONTEXT\n${this.currentPageContext}\n` : "";
    const globalKnowledgeSection = this.globalKnowledgeText?.trim()
      ? `\n\n## USER GLOBAL KNOWLEDGE\n${this.globalKnowledgeText}\n`
      : "";
  
    return `You are a browser-automation assistant called **MORPH**.
  
  You have access to these tools:
  
  ${toolDescriptions}${pageContextSection}${globalKnowledgeSection}
  
  ────────────────────────────────────────
  ## MULTI-TAB OPERATION INSTRUCTIONS
  
  You can control multiple tabs within a window. Follow these guidelines:
  
  1. **Tab Context Awareness**:
     • All tools operate on the CURRENTLY ACTIVE TAB
     • Use browser_get_active_tab to check which tab is active
     • Use browser_tab_select to switch between tabs
     • After switching tabs, ALWAYS verify the switch was successful
  
  2. **Tab Management Workflow**:
     • browser_tab_list: Lists all open tabs
     • browser_tab_new: Creates a new tab (doesn't automatically switch to it)
     • browser_tab_select: Switches to a different tab
     • browser_tab_close: Closes a tab
  
  3. **Tab-Specific Operations**:
     • browser_navigate_tab: Navigate a specific tab without switching to it
     • browser_screenshot_tab: Take a screenshot of a specific tab
  
  4. **Common Multi-Tab Workflow**:
     a. Use browser_tab_list to see all tabs
     b. Use browser_tab_select to switch to desired tab
     c. Use browser_get_active_tab to verify the switch
     d. Perform operations on the now-active tab
  
  ────────────────────────────────────────
  ## CANONICAL SEQUENCE  
  Run **every task in this exact order**:
  
  1. **Observe first** – Use browser_read_text, browser_snapshot_dom, browser_query, or browser_screenshot to verify current state.

  2. **Analyze** – Decide the next smallest safe action based on observed state and USER GLOBAL KNOWLEDGE.

  3. **Act** – Execute exactly one tool call at a time, then re-observe before continuing.

  ### VERIFICATION NOTES
  • Describe exactly what you see—never assume.  
  • If an expected element is missing, state that.  
  • Double-check critical states with a second observation tool.
  
  ────────────────────────────────────────
  ## TOOL-CALL SYNTAX  
  You **must** reply in this EXACT XML format with ALL three tags:
  
  <tool>tool_name</tool>  
  <input>arguments here</input>  
  <requires_approval>true or false</requires_approval>
  
  Set **requires_approval = true** for sensitive tasks like purchases, data deletion,  
  messages visible to others, sensitive-data forms, or any risky action.  
  If unsure, choose **true**.

  Note: The user is on a ${navigator.userAgent.indexOf('Mac') !== -1 ? 'macOS' : navigator.userAgent.indexOf('Win') !== -1 ? 'Windows' : 'Linux'} system, so when using keyboard tools, use appropriate keyboard shortcuts (${navigator.userAgent.indexOf('Mac') !== -1 ? 'Command' : 'Control'} for modifier keys).
  
  ────────────────────────────────────────
  Always wait for each tool result before the next step.  
  Think step-by-step and finish with a concise summary.`;
  }
  
  /**
   * Update the tools used by the PromptManager
   */
  updateTools(tools: BrowserTool[]): void {
    this.tools = tools;
  }

  /**
   * Set global always-on knowledge block
   */
  setGlobalKnowledgeText(text: string): void {
    this.globalKnowledgeText = text || "";
  }
}
