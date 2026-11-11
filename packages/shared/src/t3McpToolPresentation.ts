import { tr } from "@t3tools/shared/i18n";
export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-links"
  | "environment-link"
  | "environment-unlink"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface T3McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: T3McpToolSummaryAction;
}

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolSummaryAction,
  icon: T3McpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): T3McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

// Codex registers "t3-code-direct" for T3 tools kept out of Code Mode.
const T3_MCP_SERVER_ALIASES = new Set([
  "t3-code",
  "t3_code",
  "t3code",
  "t3-code-direct",
  "t3_code_direct",
]);

const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  link_pull_request: tool(
    [tr("Link"), tr("Linking"), tr("Linked"), tr("a pull request")],
    "link-pr",
    "pull-request",
  ),
  link_pull_requests: tool(
    [tr("Link"), tr("Linking"), tr("Linked"), tr("pull requests")],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    [tr("Unlink"), tr("Unlinking"), tr("Unlinked"), tr("a pull request")],
    "unlink-pr",
    "pull-request",
  ),
  unlink_pull_requests: tool(
    [tr("Unlink"), tr("Unlinking"), tr("Unlinked"), tr("pull requests by state")],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    [tr("Check"), tr("Checking"), tr("Checked"), tr("linked pull requests")],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    [tr("Watch"), tr("Watching"), tr("Watching"), tr("a pull request")],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    [tr("Stop watching"), tr("Unwatching"), tr("Stopped watching"), tr("a pull request")],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    [tr("Write"), tr("Writing"), tr("Started writing"), tr("review guides")],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("a review guide")],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    [tr("Get"), tr("Getting"), tr("Got"), tr("orchestration capabilities")],
    "capabilities",
  ),
  delegate_task: tool(
    [tr("Delegate"), tr("Delegating"), tr("Delegated"), tr("a child task")],
    "delegate",
  ),
  task_status: tool(
    [tr("Get"), tr("Getting"), tr("Got"), tr("delegated task status")],
    "task-status",
  ),
  task_cancel: tool(
    [tr("Cancel"), tr("Canceling"), tr("Requested cancellation of"), "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    [tr("Schedule"), tr("Scheduling"), tr("Scheduled"), "a task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(
    [tr("List"), tr("Listing"), tr("Listed"), "scheduled tasks"],
    "schedule-list",
  ),
  update_scheduled_task: tool(
    [tr("Update"), tr("Updating"), tr("Updated"), tr("a scheduled task")],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    [tr("Delete"), tr("Deleting"), tr("Requested deletion of"), tr("a scheduled task")],
    "schedule-delete",
  ),
  request_secret: tool(
    [tr("Ask for"), tr("Asking for"), tr("Asked for"), "a secret"],
    "secret-request",
  ),
  create_threads: tool(
    [tr("Create"), tr("Creating"), tr("Created"), tr("T3 threads")],
    "thread-create",
  ),
  t3_thread_start: tool(
    [tr("Start"), tr("Starting"), tr("Started"), tr("a T3 thread")],
    "thread-create",
  ),
  t3_thread_list: tool([tr("List"), tr("Listing"), tr("Listed"), tr("T3 threads")], "thread-list"),
  t3_thread_read: tool([tr("Read"), tr("Reading"), tr("Read"), tr("a T3 thread")], "thread-read"),
  t3_thread_send: tool(
    [tr("Send"), tr("Sending"), tr("Sent"), tr("to a T3 thread")],
    "thread-send",
  ),
  t3_thread_wait: tool(
    [tr("Wait"), tr("Waiting"), tr("Waited"), tr("for a T3 thread")],
    "thread-wait",
  ),
  t3_workflow_stop: tool(
    [tr("Stop"), tr("Stopping"), tr("Requested a stop for"), tr("a workflow")],
    "workflow-stop",
  ),
  t3_background_wait: tool(
    [tr("Update"), tr("Updating"), tr("Updated"), tr("background waits")],
    "background-wait",
  ),
  t3_thread_interrupt: tool(
    [tr("Interrupt"), tr("Interrupting"), tr("Requested an interrupt of"), tr("a T3 thread")],
    "thread-interrupt",
  ),
  t3_worktree_handoff: tool(
    [tr("Hand off"), tr("Handing off"), tr("Handed off"), tr("thread to a git worktree")],
    "worktree-handoff",
  ),
  t3_worktree_status: tool(
    [tr("Get"), tr("Getting"), tr("Got"), tr("thread worktree status")],
    "worktree-status",
  ),
  preview_status: tool(
    [tr("Get"), tr("Getting"), tr("Got"), tr("preview browser status")],
    "browser",
    "browser",
  ),
  preview_open: tool(
    [tr("Open"), tr("Opening"), tr("Opened"), tr("a page in the preview browser")],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    [tr("Navigate"), tr("Navigating"), tr("Navigated"), tr("the preview browser")],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    [tr("Respond"), tr("Responding"), tr("Responded"), tr("to a preview browser dialog")],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    [
      tr("Take a snapshot of"),
      tr("Taking a snapshot of"),
      tr("Took a snapshot of"),
      tr("the preview page"),
    ],
    "browser",
    "browser",
    tr("Snapshot the preview page"),
  ),
  preview_act: tool(
    [tr("Use"), tr("Using"), tr("Used"), tr("the preview browser")],
    "browser",
    "browser",
  ),
  preview_click: tool(
    [tr("Click"), tr("Clicking"), tr("Clicked"), tr("in the preview browser")],
    "browser",
    "browser",
  ),
  preview_press: tool(
    [tr("Press"), tr("Pressing"), tr("Pressed"), tr("a key in the preview browser")],
    "browser",
    "browser",
  ),
  preview_type: tool(
    [tr("Type"), tr("Typing"), tr("Typed"), tr("in the preview browser")],
    "browser",
    "browser",
  ),
  preview_hover: tool(
    [tr("Hover"), tr("Hovering"), tr("Hovered"), tr("in the preview browser")],
    "browser",
    "browser",
  ),
  preview_select: tool(
    [tr("Choose"), tr("Choosing"), tr("Chose"), tr("an option in the preview browser")],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    [tr("Drag"), tr("Dragging"), tr("Dragged"), tr("in the preview browser")],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    [tr("Upload"), tr("Uploading"), tr("Uploaded"), tr("files to the preview browser")],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    [tr("Scroll"), tr("Scrolling"), tr("Scrolled"), tr("the preview browser")],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    [tr("Resize"), tr("Resizing"), tr("Resized"), tr("the preview browser")],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    [tr("Evaluate"), tr("Evaluating"), tr("Evaluated"), tr("script in the preview browser")],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    [tr("Wait"), tr("Waiting"), tr("Waited"), "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    [tr("Set"), tr("Setting"), tr("Set"), tr("preview browser appearance")],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    [tr("Start"), tr("Starting"), tr("Started"), tr("recording the preview browser")],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    [tr("Stop"), tr("Stopping"), tr("Stopped"), tr("recording the preview browser")],
    "browser",
    "browser",
  ),
  device_list: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("simulators and emulators")],
    "device",
    "device",
  ),
  device_open: tool(
    [tr("Open"), tr("Opening"), tr("Opened"), tr("a device in the Device panel")],
    "device",
    "device",
  ),
  device_screenshot: tool(
    [
      tr("Take a screenshot of"),
      tr("Taking a screenshot of"),
      tr("Took a screenshot of"),
      tr("the device"),
    ],
    "device",
    "device",
  ),
  device_close: tool(
    [tr("Close"), tr("Closing"), tr("Closed"), tr("a device")],
    "device",
    "device",
  ),
  run_scheduled_task_now: tool(
    [tr("Run"), tr("Running"), tr("Requested a run of"), tr("a scheduled task")],
    "schedule-run",
  ),
  t3_queue: tool(
    [tr("Manage"), tr("Managing"), tr("Managed"), tr("queued messages")],
    "queue-edit",
  ),
  t3_pending_request: tool(
    [tr("Handle"), tr("Handling"), tr("Handled"), tr("pending questions")],
    "question-respond",
  ),
  t3_queue_list: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("queued messages")],
    "queue-list",
  ),
  t3_queue_read: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("a queued message")],
    "queue-read",
  ),
  t3_queue_edit: tool(
    [tr("Edit"), tr("Editing"), tr("Edited"), tr("a queued message")],
    "queue-edit",
  ),
  t3_queue_cancel: tool(
    [tr("Cancel"), tr("Canceling"), tr("Requested cancellation of"), tr("a queued run")],
    "queue-cancel",
  ),
  t3_queue_reorder: tool(
    [tr("Reorder"), tr("Reordering"), tr("Reordered"), tr("a queued run")],
    "queue-reorder",
  ),
  t3_queue_promote_to_steer: tool(
    [tr("Steer with"), tr("Steering with"), tr("Requested steering with"), tr("a queued message")],
    "queue-steer",
  ),
  t3_pending_request_list: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("pending questions")],
    "question-list",
  ),
  t3_pending_request_read: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("pending questions")],
    "question-read",
  ),
  t3_pending_request_respond: tool(
    [tr("Answer"), tr("Answering"), tr("Answered"), tr("pending questions")],
    "question-respond",
  ),
  t3_thread_configuration: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("thread configuration")],
    "thread-configuration",
  ),
  t3_thread_configure: tool(
    [tr("Use"), tr("Using"), tr("Used"), tr("thread model settings")],
    "thread-configure",
  ),
  t3_thread_transfer: tool(
    [tr("Use"), tr("Using"), tr("Used"), tr("thread transfers")],
    "thread-fork",
  ),
  t3_thread_fork: tool(
    [tr("Fork"), tr("Forking"), tr("Requested a fork of"), tr("this thread")],
    "thread-fork",
  ),
  t3_thread_merge_back: tool(
    [tr("Merge"), tr("Merging"), tr("Requested a merge of"), tr("thread context")],
    "thread-merge",
  ),
  t3_thread_search: tool(
    [tr("Search"), tr("Searching"), tr("Searched"), tr("thread content")],
    "thread-search",
  ),
  t3_thread_transfers: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("thread transfers")],
    "thread-transfers",
  ),
  t3_thread_organize: tool(
    [tr("Organize"), tr("Organizing"), tr("Organized"), tr("a thread")],
    "thread-organize",
  ),
  t3_thread_update: tool(
    [tr("Update"), tr("Updating"), tr("Updated"), tr("T3 thread metadata")],
    "thread-update",
  ),
  t3_worktree_list: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("workspace branches")],
    "worktree-list",
  ),
  t3_preview_list: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("preview tabs")],
    "browser",
    "browser",
  ),
  t3_preview_close: tool(
    [tr("Close"), tr("Closing"), tr("Closed"), tr("a preview tab")],
    "browser",
    "browser",
  ),
  t3_environment_read: tool(
    [tr("Read"), tr("Reading"), tr("Read"), tr("environment preferences")],
    "environment-read",
  ),
  t3_environment_links: tool(
    [tr("List"), tr("Listing"), tr("Listed"), tr("linked environments")],
    "environment-links",
  ),
  t3_environment_link: tool(
    [tr("Ask to link"), tr("Asking to link"), tr("Asked to link"), tr("an environment")],
    "environment-link",
  ),
  t3_environment_unlink: tool(
    [tr("Forget"), tr("Forgetting"), tr("Forgot"), "a linked environment"],
    "environment-unlink",
  ),
  t3_environment_preferences_update: tool(
    [tr("Update"), tr("Updating"), tr("Updated"), tr("environment preferences")],
    "environment-update",
  ),
  t3_thread_launch: tool(
    [tr("Launch"), tr("Launching"), tr("Launched"), tr("a project thread")],
    "thread-create",
  ),
  t3_project_list: tool([tr("List"), tr("Listing"), tr("Listed"), tr("projects")], "project-list"),
  t3_project_read: tool([tr("Read"), tr("Reading"), tr("Read"), tr("a project")], "project-read"),
  t3_project_create: tool(
    [tr("Register"), tr("Registering"), tr("Registered"), tr("a project")],
    "project-create",
  ),
  t3_project_update: tool(
    [tr("Update"), tr("Updating"), tr("Updated"), tr("a project")],
    "project-update",
  ),
  t3_project_delete: tool(
    [tr("Delete"), tr("Deleting"), tr("Deleted"), tr("a project")],
    "project-delete",
  ),
  t3_project_clone: tool(
    [tr("Clone"), tr("Cloning"), tr("Cloned"), tr("a repository")],
    "project-clone",
  ),
  t3_attachment_prepare_upload: tool(
    [tr("Prepare"), tr("Preparing"), tr("Prepared"), tr("an attachment upload")],
    "attachment-prepare",
  ),
  t3_attachment_discard: tool(
    [tr("Discard"), tr("Discarding"), tr("Discarded"), tr("a pending attachment")],
    "attachment-discard",
  ),
  t3_thread_send_attachments: tool(
    [tr("Send"), tr("Sending"), tr("Sent"), tr("attachments")],
    "attachment-send",
  ),
  html_preview: tool(
    [tr("Preview"), tr("Previewing"), tr("Previewed"), tr("an HTML page")],
    "html-preview",
  ),
  html_render: tool(
    [tr("Render"), tr("Rendering"), tr("Rendered"), tr("an HTML page")],
    "html-render",
  ),
};

export const T3_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T3_MCP_TOOLS));

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// Timelines resolve every work row's tool name on each update; names repeat across updates.
// ACP titles can carry whole commands, so long labels are parsed but not kept.
const toolNameCache = new Map<string, string | null>();
const TOOL_NAME_CACHE_LIMIT = 10_000;
const TOOL_NAME_CACHE_MAX_KEY_LENGTH = 256;

function resolveT3McpToolName(value: string): string | null {
  if (value.length > TOOL_NAME_CACHE_MAX_KEY_LENGTH) return parseT3McpToolName(value);
  const cached = toolNameCache.get(value);
  if (cached !== undefined) return cached;
  const name = parseT3McpToolName(value);
  if (toolNameCache.size >= TOOL_NAME_CACHE_LIMIT) toolNameCache.clear();
  toolNameCache.set(value, name);
  return name;
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function parseT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>t3[-_]code[-_]direct|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(T3_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^t3-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(T3_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveT3McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? name : null;
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  preview_act: (action) => `preview_${action}`,
  t3_queue: (action) => `t3_queue_${action}`,
  t3_pending_request: (action) => `t3_pending_request_${action}`,
  t3_thread_transfer: (action) =>
    ({ fork: "t3_thread_fork", merge_back: "t3_thread_merge_back", status: "t3_thread_transfers" })[
      action
    ],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveT3McpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolDefinition | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  if (name === null || !Object.hasOwn(T3_MCP_TOOLS, name)) return null;
  const action = asSummaryInput(input)?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(T3_MCP_TOOLS, actionTool)
    ? T3_MCP_TOOLS[actionTool]!
    : T3_MCP_TOOLS[name]!;
}

/** Tools whose summary depends on which fields a call sets. */
const ACTION_SUMMARIES: Readonly<
  Record<string, (input: SummaryInput) => T3McpToolSummaryAction | undefined>
> = {
  t3_thread_configure: ({ modelSelection }) =>
    modelSelection === undefined ? "thread-configuration" : "thread-configure",
  schedule_task: ({ scheduledTaskId }) =>
    scheduledTaskId === undefined ? "schedule-create" : "schedule-update",
};

export function resolveT3McpSummaryAction(
  toolName: string | null | undefined,
  input: unknown,
): T3McpToolSummaryAction | null {
  const definition = resolveT3McpToolDefinition(toolName, input);
  if (definition === null) return null;
  const summarize = ACTION_SUMMARIES[resolveT3McpToolName(toolName!) ?? ""];
  const fields = asSummaryInput(input);
  return (fields && summarize?.(fields)) ?? definition.summaryAction;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolPresentation | null {
  const definition = resolveT3McpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}
