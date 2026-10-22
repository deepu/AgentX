/**
 * User-friendly display names for tools.
 *
 * Internal tool names are developer-facing and can be cryptic.
 * This mapping provides cleaner names for the UI.
 */

/**
 * Display names for specific tools that need custom names
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Built-in tools
  'Glob': 'Finding Files',
  'Grep': 'Searching Files',
  'Read': 'Reading File',
  'Write': 'Writing File',
  'Edit': 'Editing File',
  'Bash': 'Running Command',
  'Task': 'Running Agent',
  'Agent': 'Running Agent',
  'WebFetch': 'Fetching URL',
  'WebSearch': 'Searching Web',
  'TodoWrite': 'Updating Tasks',
  'NotebookEdit': 'Editing Notebook',
};

/**
 * Plain labels for session tools that people who aren't developers meet, on permission
 * cards and in the chat's activity rows: the MemWise playbook tools of a build/change chat
 * (docs/memwise/20-phase-3-interfaces.md §4) and the record tools of a record chat. Say what happens, in the person's words.
 */
const PLAIN_SESSION_TOOL_LABELS: Record<string, string> = {
  playbook_vocabulary: 'Look up what a playbook may use',
  playbook_read: 'Read the playbook',
  playbook_write: 'Edit the draft',
  playbook_diff: 'Show what the draft changes',
  playbook_check: 'Check the draft',
  playbook_finish: 'Send the draft for review',
  // A chat anchored to a record (docs/memwise/25-literature-poc.md §6)
  project_options: 'Look up what a project can start from',
  project_draft: 'Draft the project',
  record_get: 'Read a record',
  record_query: 'Look up records',
  record_keep: 'Keep in MemWise',
  record_update: 'Fill in the draft',
};

/**
 * The plain label of a session tool (`mcp__session__playbook_finish` → "Send the draft for
 * review"), or undefined when it has none. Source tools of the same name are not matched.
 */
export function getPlainToolLabel(toolName: string): string | undefined {
  const base = toolName.replace(/^(mcp__session__|session__)/, '');
  return Object.hasOwn(PLAIN_SESSION_TOOL_LABELS, base) ? PLAIN_SESSION_TOOL_LABELS[base] : undefined;
}

/**
 * Set of tool names that represent parent task tools (subagent launchers).
 * The SDK renamed 'Task' to 'Agent' in v0.2.72 — both must be recognised.
 * Add future renames here instead of scattering checks across the codebase.
 */
export const PARENT_TASK_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Check whether a tool name is a parent task tool (Task or Agent). */
export const isParentTaskTool = (name: string): boolean => PARENT_TASK_TOOLS.has(name);

/**
 * Tools that should be hidden from the UI (purely internal state changes)
 */
export const HIDDEN_TOOLS = new Set<string>([
  // Currently empty - safe mode is toggled via UI, not tools
]);

/**
 * Format tool name for display (snake_case to Title Case)
 * Generic fallback for tools without explicit mappings
 */
function formatToolName(name: string): string {
  // Handle MCP tools (mcp__server__tool)
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const tool = parts[2] || parts[1] || name;
    return tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Handle api_* tools
  if (name.startsWith('api_')) {
    const apiName = name.slice(4); // Remove 'api_' prefix
    return `API: ${apiName.charAt(0).toUpperCase() + apiName.slice(1)}`;
  }

  // Default: convert to title case
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get user-friendly display name for a tool.
 *
 * @param toolName - The internal tool name (e.g., "mcp__linear__list_issues")
 * @returns User-friendly display name
 */
export function getToolDisplayName(toolName: string): string {
  // Check explicit mappings first (full name)
  if (TOOL_DISPLAY_NAMES[toolName]) {
    return TOOL_DISPLAY_NAMES[toolName];
  }

  // For MCP tools, also check mapping with just the base tool name
  // e.g., "mcp__linear__list_issues" -> check "list_issues"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || toolName;
    if (baseName && TOOL_DISPLAY_NAMES[baseName]) {
      return TOOL_DISPLAY_NAMES[baseName];
    }
  }

  // Fallback to generic formatting
  return formatToolName(toolName);
}

/**
 * Check if a tool should be hidden from the UI
 */
export function shouldHideTool(toolName: string): boolean {
  // Check full name first
  if (HIDDEN_TOOLS.has(toolName)) {
    return true;
  }

  // For MCP tools, also check the base name
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || '';
    return HIDDEN_TOOLS.has(baseName);
  }

  return false;
}
