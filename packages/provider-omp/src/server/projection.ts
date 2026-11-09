// omp frame → ProviderAdapterV2Event projection (spec §5.5, one per thread/process pair).
// Hard constraints (#8): runAttemptId on every turn event, no user/root emission, terminal success
// carries { status, failure, runOrdinal, threadDisposition }. Approvals (#16): extension_ui_request
// → approval item + runtime request, replay/audit only; answering lives in adapter.ts.
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ServerProviderSlashCommand,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { OmpRpcFrame } from "./rpc/frames.ts";

export interface OmpNativeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
}

/** "default" defers to omp's own resolution (settings default role → first authed provider). */
export const OMP_INHERIT_MODEL_SLUG = "default";

/** A concrete omp model: catalog slug `provider/modelId` split into its RPC pair. */
export interface OmpModelRef {
  readonly slug: string;
  readonly provider: string;
  readonly modelId: string;
}

export const parseOmpModelSlug = (slug: string): OmpModelRef | null => {
  if (slug === OMP_INHERIT_MODEL_SLUG) return null;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return {
    slug,
    provider: slug.slice(0, separator),
    modelId: slug.slice(separator + 1),
  };
};

interface OmpStreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  text: string;
  completed: boolean;
}

interface OmpToolItem {
  readonly nativeItemId: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly title: string;
  readonly input: unknown;
  output?: unknown;
  isError?: boolean;
  completed: boolean;
}

export interface OmpActiveTurn {
  providerTurn: OrchestrationV2ProviderTurn;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly nativeTurnId: string;
  readonly streamItems: Map<string, OmpStreamItem>;
  readonly tools: Map<string, OmpToolItem>;
  /** Compaction hint line currently open (start frame seen, end frame pending). */
  activeCompaction: OmpCompactionItem | null;
  /** An agent_end with isTerminal:false arrived; terminal waits for the next real agent_end. */
  awaitingAgentEnd: boolean;
  deferredPromptResult: OmpRpcFrame | null;
  nextItemOrdinal: number;
}

/** One omp `select` option and the T3 decision its label maps to (undefined = unmapped). */
export interface OmpApprovalChoice {
  readonly value: string;
  readonly decision: ProviderApprovalDecision | undefined;
}

export interface OmpPendingRuntimeRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  /** The omp extension_ui_request dialog id, echoed back by extension_ui_response. */
  readonly nativeRequestId: string;
  readonly toolName: string;
  readonly choices: ReadonlyArray<OmpApprovalChoice>;
  /** Set while the answer is in flight so a double respond fails instead of double-sending. */
  answering: boolean;
}

/** One transcript compaction hint line (omp auto/manual_compaction_start). */
interface OmpCompactionItem {
  readonly nativeItemId: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
}

/** ContextWindowMeter reading parsed from omp `get_state` (SessionState.contextUsage). */
export interface OmpContextUsageReading {
  readonly usedTokens: number;
  /** `null` when omp could not report the model context window. */
  readonly maxTokens: number | null;
}

export interface OmpThreadProjectionState {
  providerThread: OrchestrationV2ProviderThread;
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  active: OmpActiveTurn | null;
  /** Frames that landed between turns (fake-harness races); replayed at the next turn start. */
  orphanFrames: ReadonlyArray<OmpRpcFrame>;
  nativeSession: OmpNativeSession | null;
  /**
   * The model the omp process currently runs on (#17). Written after a successful set_model /
   * switch_session restore and on `model_changed` frames; `null` = omp's own resolution. The
   * thread metadata mirrors the slug verbatim (no catalog filtering — vanished models keep
   * their selection until omp itself fails the restore, which surfaces fail-closed).
   */
  appliedModel: OmpModelRef | null;
  /** Approval dialogs (spec §6) keyed by their omp request id; audit lives here too. */
  runtimeRequests: Map<string, OmpPendingRuntimeRequest>;
  /**
   * The thinking level the omp process currently runs on (#21). Written only after omp
   * confirmed `set_thinking_level`; `null` = omp's own baseline. Kept beside #17's
   * appliedModel in projection state — the nativeMetadata schema is outside this ticket's
   * reach (contracts), and omp persists the level in its own session across respawns.
   */
  appliedThinking: string | null;
}

export interface OmpThreadProjection {
  readonly state: OmpThreadProjectionState;
  readonly handleFrame: (frame: OmpRpcFrame) => Effect.Effect<void>;
  /** Replays frames buffered while no turn was active; called right after a turn goes active. */
  readonly flushOrphanFrames: Effect.Effect<void>;
  readonly beginTurn: (input: {
    readonly providerTurn: OrchestrationV2ProviderTurn;
    readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  }) => OmpActiveTurn;
  readonly finalizeTurn: (
    status: "completed" | "interrupted" | "failed",
    failure?: OrchestrationV2ProviderFailure,
  ) => Effect.Effect<void>;
  readonly markThreadStatus: (
    status: OrchestrationV2ProviderThread["status"],
  ) => Effect.Effect<void>;
  /** Records an applied model in thread metadata (nativeMetadata.modelSelection) and emits. */
  readonly applyModel: (model: OmpModelRef) => Effect.Effect<void>;
  /** Records a confirmed thinking level (#21) so the next turn skips a redundant dispatch. */
  readonly applyThinking: (level: string) => Effect.Effect<void>;
}

const isOmpApprovalRequestFrame = (frame: OmpRpcFrame): boolean =>
  frameString(frame, "type") === "extension_ui_request" &&
  frameString(frame, "method") === "select";

/**
 * Spec §6 three-choice labels mapped by words, not position: omp builds its own option list
 * (variants like "Approve Once" / "Deny and explain" exist across versions).
 */
const ompDecisionForOption = (option: string): ProviderApprovalDecision | undefined => {
  const normalized = option.trim().toLowerCase();
  if (/^deny/.test(normalized)) return "decline";
  if (/^approv/.test(normalized) && normalized.includes("session")) return "acceptForSession";
  if (/^approv/.test(normalized) || /^allow/.test(normalized)) return "accept";
  return undefined;
};

/**
 * Decision → extension_ui_response params (spec §6): the omp option string is passed through
 * when its label maps to the decision; canonical fallbacks cover degenerate frames. `cancel`
 * dismisses the dialog, letting omp resolve its own default; `acceptAlways` is refused by the
 * adapter before this helper runs (omp has no cross-session Always).
 */
export const ompResponseValueFor = (
  approval: {
    readonly nativeRequestId: string;
    readonly toolName: string;
    readonly choices: ReadonlyArray<OmpApprovalChoice>;
  },
  decision: ProviderApprovalDecision,
): Record<string, unknown> => {
  const id = approval.nativeRequestId;
  if (decision === "cancel") return { id, cancelled: true };
  const matched = approval.choices.find((choice) => choice.decision === decision)?.value;
  const fallback =
    decision === "accept"
      ? "Approve"
      : decision === "acceptForSession"
        ? `Approve ${approval.toolName} for this session`
        : "Deny";
  return { id, value: matched ?? fallback };
};

const driverRef = (
  driver: ProviderDriverKind,
  nativeId: string,
  strength: "strong" | "weak",
): OrchestrationV2ProviderThread["nativeThreadRef"] => ({ driver, nativeId, strength });

const frameString = (frame: OmpRpcFrame, key: string): string | undefined => {
  const value = frame[key];
  return typeof value === "string" ? value : undefined;
};

const frameRecord = (frame: OmpRpcFrame, key: string): Record<string, unknown> | undefined => {
  const value = frame[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * omp `available_commands_update` → the contracts slash-command catalog (spec §5.5/§7). Every
 * frame carries the full replacement catalog; entries without a usable name are dropped and
 * omp-only fields (`source`, `aliases`, `subcommands`) have no contract slot. Undefined for any
 * other frame, or a directory frame without a `commands` array (tolerated, spec §5.5).
 */
export const ompSlashCommandsFromFrame = (
  frame: OmpRpcFrame,
): ReadonlyArray<ServerProviderSlashCommand> | undefined => {
  if (frameString(frame, "type") !== "available_commands_update") return undefined;
  const commands = frame["commands"];
  if (!Array.isArray(commands)) return undefined;
  const catalog: ServerProviderSlashCommand[] = [];
  for (const entry of commands) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.trim() === "") continue;
    const description = record["description"];
    const input = frameRecord(record, "input");
    const hint = input === undefined ? undefined : input["hint"];
    catalog.push({
      name,
      ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
      ...(typeof hint === "string" && hint.trim() !== "" ? { input: { hint } } : {}),
    });
  }
  return catalog;
};

const failureFromPromptError = (error: Record<string, unknown>): OrchestrationV2ProviderFailure => {
  const message = typeof error["message"] === "string" ? error["message"] : "omp turn failed";
  const code = typeof error["code"] === "string" ? error["code"] : null;
  const retryable = typeof error["retryable"] === "boolean" ? error["retryable"] : null;
  return { class: "provider_error", message, code, retryable };
};

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const positiveInteger = (value: unknown): number | undefined => {
  const parsed = nonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

/**
 * omp `get_state` → SessionState.contextUsage (`{ tokens, contextWindow, percent }`) — the
 * ContextWindowMeter reading. Undefined when the session reports no usage yet; readings are
 * never fabricated.
 */
const ompContextUsageFromState = (data: unknown): OmpContextUsageReading | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const usage = frameRecord(data as OmpRpcFrame, "contextUsage");
  if (usage === undefined) return undefined;
  const usedTokens = nonNegativeInteger(usage["tokens"]);
  if (usedTokens === undefined) return undefined;
  const contextWindow = positiveInteger(usage["contextWindow"]);
  return { usedTokens, maxTokens: contextWindow ?? null };
};

/**
 * omp `Usage` (attached to every assistant message, delivered by `message_end`) → the live
 * turn tokenUsage. `contextTokens` (context size incl. system prompt) is the meter number and
 * falls back to the request total; `maxTokens` arrives only from get_state readings.
 */
const liveTurnTokenUsage = (
  message: Record<string, unknown>,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderTurnTokenUsage | undefined => {
  const usage = frameRecord(message, "usage");
  if (usage === undefined) return undefined;
  const inputTokens = nonNegativeInteger(usage["input"]);
  const cachedInputTokens = nonNegativeInteger(usage["cacheRead"]);
  const outputTokens = nonNegativeInteger(usage["output"]);
  const reasoningOutputTokens = nonNegativeInteger(usage["reasoningTokens"]);
  const cacheWriteTokens = nonNegativeInteger(usage["cacheWrite"]);
  const summedRequestTokens =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0);
  const usedTokens =
    nonNegativeInteger(usage["contextTokens"]) ??
    nonNegativeInteger(usage["totalTokens"]) ??
    summedRequestTokens;
  if (usedTokens === undefined) return undefined;
  return {
    usedTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    updatedAt: DateTime.formatIso(updatedAt),
  };
};

/** Terminal get_state reading wins on usedTokens/maxTokens; live counters ride along. */
const mergeTurnTokenUsage = (
  live: OrchestrationV2ProviderTurnTokenUsage | undefined,
  reading: OmpContextUsageReading,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderTurnTokenUsage => ({
  ...live,
  usedTokens: reading.usedTokens,
  ...(reading.maxTokens === null ? {} : { maxTokens: reading.maxTokens }),
  updatedAt: DateTime.formatIso(updatedAt),
});

function compactionTitle(status: "running" | "completed" | "failed" | "cancelled"): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

export const createOmpThreadProjection = (input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly state: OmpThreadProjectionState;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly updateSession: (
    status: OrchestrationV2ProviderSession["status"],
    lastError?: string | null,
  ) => Effect.Effect<void>;
  /** Runs after the turn.terminal emission (active already cleared); drives queued switches. */
  readonly onTurnSettled?: (turn: OmpActiveTurn) => Effect.Effect<void>;
  /** Raw omp `get_state` data for meter readings; failures are swallowed by the projection. */
  readonly readSessionState: Effect.Effect<unknown, unknown>;
}): OmpThreadProjection => {
  const { driver, state } = input;

  const updateThread = Effect.fnUntraced(function* (patch: Partial<OrchestrationV2ProviderThread>) {
    const updatedAt = yield* DateTime.now;
    state.providerThread = { ...state.providerThread, ...patch, updatedAt };
    yield* input.emit({
      type: "provider_thread.updated",
      driver,
      providerThread: state.providerThread,
    });
  });

  const emitNode = Effect.fnUntraced(function* (
    turn: OmpActiveTurn,
    nativeItemId: string,
    kind: "assistant_message" | "reasoning" | "tool_call" | "system",
    itemStatus: OrchestrationV2TurnItem["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
  ) {
    yield* input.emit({
      type: "node.updated",
      driver,
      node: {
        id: IdAllocator.derive.nodeFromProviderItem({ driver, nativeItemId }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        parentNodeId: turn.turnInput.rootNodeId,
        rootNodeId: turn.turnInput.rootNodeId,
        kind,
        status: itemStatus,
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: driverRef(driver, nativeItemId, "strong"),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    });
  });

  const itemBase = (turn: OmpActiveTurn, item: { nativeItemId: string; ordinal: number }) => ({
    id: IdAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: item.nativeItemId }),
    threadId: turn.turnInput.threadId,
    runId: turn.turnInput.runId,
    nodeId: IdAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: item.nativeItemId }),
    providerThreadId: state.providerThread.id,
    providerTurnId: turn.providerTurn.id,
    nativeItemRef: driverRef(driver, item.nativeItemId, "strong"),
    parentItemId: null,
    ordinal: item.ordinal,
  });

  const emitStreamItem = Effect.fnUntraced(function* (
    turn: OmpActiveTurn,
    item: OmpStreamItem,
    streaming: boolean,
  ) {
    const emittedAt = yield* DateTime.now;
    const itemStatus: OrchestrationV2TurnItem["status"] = streaming ? "running" : "completed";
    yield* emitNode(
      turn,
      item.nativeItemId,
      item.kind,
      itemStatus,
      item.startedAt,
      streaming ? null : emittedAt,
    );
    const base = {
      ...itemBase(turn, item),
      status: itemStatus,
      title: null,
      startedAt: item.startedAt,
      completedAt: streaming ? null : emittedAt,
      updatedAt: emittedAt,
    };
    if (item.kind === "assistant_message") {
      const messageId = IdAllocator.derive.messageFromProviderItem({
        driver,
        nativeItemId: item.nativeItemId,
      });
      // Contract: turn_item.updated(assistant_message) + message.updated are emitted as a pair.
      yield* input.emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...base, type: "assistant_message", messageId, text: item.text, streaming },
      });
      const message: OrchestrationV2ConversationMessage = {
        id: messageId,
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: base.nodeId,
        role: "assistant",
        text: item.text,
        attachments: [],
        streaming,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: item.startedAt,
        updatedAt: emittedAt,
      };
      if (!streaming) {
        state.messages = [...state.messages, message];
      }
      yield* input.emit({ type: "message.updated", driver, message });
      return;
    }
    yield* input.emit({
      type: "turn_item.updated",
      driver,
      turnItem: { ...base, type: "reasoning", text: item.text, streaming },
    });
  });

  const emitToolItem = Effect.fnUntraced(function* (turn: OmpActiveTurn, tool: OmpToolItem) {
    const emittedAt = yield* DateTime.now;
    const itemStatus: OrchestrationV2TurnItem["status"] = tool.completed
      ? tool.isError === true
        ? "failed"
        : "completed"
      : "running";
    yield* emitNode(
      turn,
      tool.nativeItemId,
      "tool_call",
      itemStatus,
      tool.startedAt,
      tool.completed ? emittedAt : null,
    );
    yield* input.emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemBase(turn, tool),
        status: itemStatus,
        title: tool.title,
        startedAt: tool.startedAt,
        completedAt: tool.completed ? emittedAt : null,
        updatedAt: emittedAt,
        type: "dynamic_tool",
        toolName: tool.title,
        input: tool.input,
        ...(tool.output === undefined ? {} : { output: tool.output }),
      } satisfies OrchestrationV2TurnItem,
    });
  });

  const compactionItemFor = (turn: OmpActiveTurn, startedAt: DateTime.Utc): OmpCompactionItem => {
    const ordinal = turn.nextItemOrdinal++;
    return { nativeItemId: `${turn.nativeTurnId}:compaction:${ordinal}`, ordinal, startedAt };
  };

  const emitCompactionItem = Effect.fnUntraced(function* (
    turn: OmpActiveTurn,
    item: OmpCompactionItem,
    status: "running" | "completed" | "failed" | "cancelled",
    details: {
      readonly summary?: string;
      readonly beforeTokenCount?: number;
    } = {},
  ) {
    const emittedAt = yield* DateTime.now;
    const completedAt = status === "running" ? null : emittedAt;
    yield* emitNode(turn, item.nativeItemId, "system", status, item.startedAt, completedAt);
    yield* input.emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemBase(turn, item),
        status,
        title: compactionTitle(status),
        startedAt: item.startedAt,
        completedAt,
        updatedAt: emittedAt,
        type: "compaction",
        driver,
        ...details,
      } satisfies OrchestrationV2TurnItem,
    });
  });

  const readContextUsage: Effect.Effect<OmpContextUsageReading | undefined> = Effect.suspend(() =>
    input.readSessionState.pipe(
      // Meter reads are best-effort and never block the lifeline: cap at 2s, swallow every
      // failure (pi does the same for its stats probe). No response, no fabricated reading.
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => undefined),
      Effect.map(ompContextUsageFromState),
    ),
  );

  const contextUsageSnapshot = (reading: OmpContextUsageReading): ThreadTokenUsageSnapshot => ({
    usedTokens: reading.usedTokens,
    ...(reading.maxTokens === null ? {} : { maxTokens: reading.maxTokens }),
    // omp compacts natively when the context fills (spec §7); the meter bit reflects that.
    compactsAutomatically: true,
  });

  const refreshContextUsageMeter = Effect.suspend(() =>
    Effect.flatMap(readContextUsage, (reading) =>
      reading === undefined
        ? Effect.void
        : updateThread({ contextUsage: contextUsageSnapshot(reading) }),
    ),
  );

  /** Live turn tokenUsage from an omp `message_end` message (omp Usage → meter reading). */
  const applyLiveTurnUsage = Effect.fnUntraced(function* (
    turn: OmpActiveTurn,
    message: Record<string, unknown> | undefined,
  ) {
    const tokenUsage =
      message === undefined ? undefined : liveTurnTokenUsage(message, yield* DateTime.now);
    if (tokenUsage === undefined) return;
    turn.providerTurn = { ...turn.providerTurn, tokenUsage };
    yield* input.emit({
      type: "provider_turn.updated",
      driver,
      threadId: turn.turnInput.threadId,
      providerTurn: turn.providerTurn,
    });
  });

  // Top-level authoritative message_end (omp wire MessageEndEvent): its AgentMessage carries
  // the full omp Usage — the meter's live reading source.
  const handleMessageEndFrame = Effect.fnUntraced(function* (frame: OmpRpcFrame) {
    const turn = state.active;
    if (turn === null) return;
    yield* completeOpenStreamItems(turn);
    yield* applyLiveTurnUsage(turn, frameRecord(frame, "message"));
  });

  const handleCompactionStart = Effect.fnUntraced(function* (_frame: OmpRpcFrame) {
    const turn = state.active;
    if (turn === null) return;
    // A still-open compaction (its end frame never landed) closes as cancelled before the
    // next one begins — the transcript never shows two open hint lines.
    if (turn.activeCompaction !== null) {
      yield* emitCompactionItem(turn, turn.activeCompaction, "cancelled");
    }
    const item = compactionItemFor(turn, yield* DateTime.now);
    turn.activeCompaction = item;
    yield* emitCompactionItem(turn, item, "running");
  });

  const handleCompactionEnd = Effect.fnUntraced(function* (frame: OmpRpcFrame) {
    const turn = state.active;
    if (turn === null) return;
    const observedAt = yield* DateTime.now;
    const item = turn.activeCompaction ?? compactionItemFor(turn, observedAt);
    turn.activeCompaction = null;
    const result = frameRecord(frame, "result");
    if (result !== undefined) {
      const summary = frameString(result, "summary");
      const beforeTokenCount = nonNegativeInteger(result["tokensBefore"]);
      yield* emitCompactionItem(turn, item, "completed", {
        ...(summary === undefined ? {} : { summary }),
        ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
      });
      yield* refreshContextUsageMeter;
      return;
    }
    if (frame["aborted"] === true) {
      yield* emitCompactionItem(turn, item, "cancelled");
      return;
    }
    if (frame["skipped"] === true) {
      // Benign skip: nothing met the compaction bar; omp explains why in errorMessage.
      yield* emitCompactionItem(turn, item, "completed", {
        summary: frameString(frame, "errorMessage") ?? "Nothing to compact",
      });
      yield* refreshContextUsageMeter;
      return;
    }
    yield* emitCompactionItem(turn, item, "failed", {
      summary: frameString(frame, "errorMessage") ?? "omp context compaction failed",
    });
  });

  const streamItemFor = Effect.fnUntraced(function* (
    turn: OmpActiveTurn,
    kind: OmpStreamItem["kind"],
    contentIndex: number,
  ) {
    const nativeItemId = `${turn.nativeTurnId}:c${contentIndex}`;
    const existing = turn.streamItems.get(nativeItemId);
    if (existing !== undefined) return existing;
    const item: OmpStreamItem = {
      nativeItemId,
      kind,
      ordinal: turn.nextItemOrdinal++,
      startedAt: yield* DateTime.now,
      text: "",
      completed: false,
    };
    turn.streamItems.set(nativeItemId, item);
    return item;
  });

  const completeStreamItem = (turn: OmpActiveTurn, item: OmpStreamItem, text?: string) =>
    Effect.suspend(() => {
      if (item.completed) return Effect.void;
      item.completed = true;
      if (text !== undefined && text.length > 0) item.text += text;
      return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
    });

  const completeOpenStreamItems = (turn: OmpActiveTurn) =>
    Effect.forEach(
      Array.from(turn.streamItems.values()).filter((item) => !item.completed),
      (item) => completeStreamItem(turn, item),
      { discard: true },
    );

  const completeOpenTools = (turn: OmpActiveTurn) =>
    Effect.forEach(
      Array.from(turn.tools.values()).filter((tool) => !tool.completed),
      (tool) => {
        tool.completed = true;
        return emitToolItem(turn, tool);
      },
      { discard: true },
    );

  const handlePromptResult = (frame: OmpRpcFrame) =>
    Effect.suspend(() => {
      const turn = state.active;
      if (turn === null) return Effect.void;
      if (turn.awaitingAgentEnd) {
        // A maintenance agent_end (isTerminal:false) means the run keeps going; hold the
        // prompt_result until the real terminal agent_end lands (notes rpc-protocol §5).
        turn.deferredPromptResult = frame;
        return Effect.void;
      }
      const status = frameString(frame, "status");
      if (status === "aborted") return finalizeTurn("interrupted");
      if (status === "error") {
        return finalizeTurn("failed", failureFromPromptError(frameRecord(frame, "error") ?? {}));
      }
      return finalizeTurn("completed");
    });

  const handleAgentEnd = (frame: OmpRpcFrame) =>
    Effect.suspend(() => {
      const turn = state.active;
      if (turn === null) return Effect.void;
      if (frame["isTerminal"] === false) {
        turn.awaitingAgentEnd = true;
        return Effect.void;
      }
      turn.awaitingAgentEnd = false;
      if (turn.deferredPromptResult !== null) {
        const deferred = turn.deferredPromptResult;
        turn.deferredPromptResult = null;
        return handlePromptResult(deferred);
      }
      return Effect.void;
    });

  /** Cancels approvals their turn left behind; omp already rejected the dialogs on its side. */
  const cancelLeftoverRequests = Effect.fnUntraced(function* () {
    for (const entry of state.runtimeRequests.values()) {
      if (entry.request.status !== "pending") continue;
      const now = yield* DateTime.now;
      const cancelled: OrchestrationV2RuntimeRequest = {
        ...entry.request,
        status: "cancelled",
        resolvedAt: now,
      };
      state.runtimeRequests.set(entry.nativeRequestId, {
        ...entry,
        request: cancelled,
        node: { ...entry.node, status: "cancelled", completedAt: now },
        item: { ...entry.item, status: "cancelled", completedAt: now, updatedAt: now },
      });
      yield* input.emit({
        type: "runtime_request.updated",
        driver,
        threadId: entry.item.threadId,
        runtimeRequest: cancelled,
      });
      yield* input.emit({
        type: "node.updated",
        driver,
        node: { ...entry.node, status: "cancelled", completedAt: now },
      });
      yield* input.emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...entry.item, status: "cancelled", completedAt: now, updatedAt: now },
      });
    }
  });

  const finalizeTurn = Effect.fnUntraced(function* (
    status: "completed" | "interrupted" | "failed",
    failure?: OrchestrationV2ProviderFailure,
  ) {
    const turn = state.active;
    if (turn === null) return;
    state.active = null;
    const completedAt = yield* DateTime.now;
    yield* completeOpenStreamItems(turn);
    yield* completeOpenTools(turn);
    yield* cancelLeftoverRequests();
    // An interrupted compaction never dangles open in the transcript.
    if (turn.activeCompaction !== null) {
      yield* emitCompactionItem(turn, turn.activeCompaction, "cancelled");
      turn.activeCompaction = null;
    }
    // D9: the terminal reading refreshes the meter and lands on the final turn event;
    // interrupted/failed turns keep whatever live usage already projected.
    const reading = status === "completed" ? yield* readContextUsage : undefined;
    const tokenUsage =
      reading === undefined
        ? turn.providerTurn.tokenUsage
        : mergeTurnTokenUsage(turn.providerTurn.tokenUsage, reading, completedAt);
    const finalTurn: OrchestrationV2ProviderTurn = {
      ...turn.providerTurn,
      status: status === "failed" ? "failed" : status,
      completedAt,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    };
    state.turns = [...state.turns, finalTurn];
    yield* input.emit({
      type: "provider_turn.updated",
      driver,
      threadId: turn.turnInput.threadId,
      providerTurn: finalTurn,
    });
    yield* updateThread({
      status: status === "failed" ? "error" : "idle",
      ...(reading === undefined ? {} : { contextUsage: contextUsageSnapshot(reading) }),
    });
    yield* input.updateSession(status === "failed" ? "error" : "ready", failure?.message ?? null);
    if (status === "failed") {
      const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
      const failureDetail =
        failure ??
        ({
          class: "provider_error",
          message: "omp turn failed",
          code: null,
          retryable: null,
        } as const);
      yield* input.emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: IdAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: failureItemId }),
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          nodeId: null,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: driverRef(driver, failureItemId, "weak"),
          parentItemId: null,
          ordinal: turn.nextItemOrdinal++,
          status: "failed",
          title: null,
          startedAt: completedAt,
          completedAt: completedAt,
          updatedAt: completedAt,
          type: "error",
          failure: failureDetail,
        },
      });
      yield* input.emit({
        type: "turn.terminal",
        driver,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.turnInput.runOrdinal,
        failureItemOrdinal: turn.nextItemOrdinal - 1,
        status: "failed",
        failure: failureDetail,
        threadDisposition: "reusable",
      });
      if (input.onTurnSettled !== undefined) yield* input.onTurnSettled(turn);
      return;
    }
    yield* input.emit({
      type: "turn.terminal",
      driver,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      runOrdinal: turn.turnInput.runOrdinal,
      status,
      failure: null,
      threadDisposition: "reusable",
    });
    if (input.onTurnSettled !== undefined) yield* input.onTurnSettled(turn);
  });

  const handleMessageUpdate = Effect.fnUntraced(function* (frame: OmpRpcFrame) {
    const turn = state.active;
    const event = frameRecord(frame, "assistantMessageEvent");
    const type = event === undefined ? undefined : frameString(event, "type");
    if (turn === null || event === undefined || type === undefined) return;
    const contentIndex = typeof event["contentIndex"] === "number" ? event["contentIndex"] : 0;
    const delta = typeof event["delta"] === "string" ? event["delta"] : undefined;
    switch (type) {
      case "text_start":
      case "thinking_start": {
        yield* streamItemFor(
          turn,
          type === "text_start" ? "assistant_message" : "reasoning",
          contentIndex,
        );
        return;
      }
      case "text_delta":
      case "thinking_delta": {
        const key = `${turn.nativeTurnId}:c${contentIndex}`;
        let item = turn.streamItems.get(key);
        if (item === undefined) {
          item = yield* streamItemFor(
            turn,
            type === "text_delta" ? "assistant_message" : "reasoning",
            contentIndex,
          );
        }
        item.text += delta ?? "";
        yield* emitStreamItem(turn, item, true);
        return;
      }
      case "text_end":
      case "thinking_end": {
        const item = turn.streamItems.get(`${turn.nativeTurnId}:c${contentIndex}`);
        if (item === undefined) return;
        yield* completeStreamItem(turn, item, delta);
        return;
      }
      case "message_end": {
        yield* completeOpenStreamItems(turn);
        // Delta-projected message_update: usage may ride on the event's message (or the
        // slimmed frame's); the authoritative top-level message_end is handled separately.
        yield* applyLiveTurnUsage(
          turn,
          frameRecord(event, "message") ?? frameRecord(frame, "message"),
        );
        return;
      }
      default:
        return;
    }
  });

  const handleToolExecution = Effect.fnUntraced(function* (
    frame: OmpRpcFrame,
    phase: "start" | "end",
  ) {
    const turn = state.active;
    if (turn === null) return;
    const nativeItemId = frameString(frame, "toolCallId") ?? frameString(frame, "id");
    if (nativeItemId === undefined) return;
    const title = frameString(frame, "toolName") ?? frameString(frame, "name") ?? "tool";
    if (phase === "start") {
      const existing = turn.tools.get(nativeItemId);
      if (existing !== undefined) {
        yield* emitToolItem(turn, existing);
        return;
      }
      const tool = {
        nativeItemId,
        ordinal: turn.nextItemOrdinal++,
        startedAt: yield* DateTime.now,
        title,
        input: frame["args"] ?? frame["input"] ?? {},
        completed: false,
      };
      turn.tools.set(nativeItemId, tool);
      yield* emitToolItem(turn, tool);
      return;
    }
    const tool = turn.tools.get(nativeItemId);
    if (tool === undefined) return;
    tool.completed = true;
    if (frame["isError"] === true) tool.isError = true;
    const result = frameRecord(frame, "result") ?? frame["output"];
    if (result !== undefined) tool.output = result;
    yield* emitToolItem(turn, tool);
  });

  const applyModel = Effect.fnUntraced(function* (model: OmpModelRef) {
    state.appliedModel = model;
    const updatedAt = yield* DateTime.now;
    state.providerThread = {
      ...state.providerThread,
      nativeMetadata: {
        ...state.providerThread.nativeMetadata,
        modelSelection: { instanceId: input.instanceId, model: model.slug },
      },
      updatedAt,
    };
    yield* input.emit({
      type: "provider_thread.updated",
      driver,
      providerThread: state.providerThread,
    });
  });

  const runtimeRequestIdFromNative = (nativeRequestId: string): RuntimeRequestId =>
    // Pure derive (spec §5.5): deterministic, so a duplicate omp dialog id maps to one request.
    // Mirrors the joinId shape of IdAllocatorV2.allocate.runtimeRequest.
    RuntimeRequestId.make(
      `runtime-request:provider:${driver}:native-request:${encodeURIComponent(nativeRequestId)}`,
    );

  const approvalOptionsFor = (toolName: string): ReadonlyArray<ProviderApprovalOption> => [
    // Spec §6 three-choice pass-through: Approve / Approve <tool> for this session / Deny.
    // Session-scoped grants are remembered inside the omp process; no cross-session Always.
    { decision: "accept", label: "Approve" },
    { decision: "acceptForSession", label: `Approve ${toolName} for this session` },
    { decision: "decline", label: "Deny" },
  ];

  const handleExtensionUiRequest = Effect.fnUntraced(function* (frame: OmpRpcFrame) {
    if (!isOmpApprovalRequestFrame(frame)) return; // setWidget/notify/… stay tolerated (spec §5.5)
    const nativeRequestId = frameString(frame, "id");
    if (nativeRequestId === undefined) return;
    const turn = state.active;
    // Approvals live only inside their turn; without one omp resolves its own default later.
    if (turn === null) return;
    if (state.runtimeRequests.has(nativeRequestId)) return;
    const rawOptions = Array.isArray(frame["options"]) ? frame["options"] : [];
    const choices = rawOptions
      .filter((option): option is string => typeof option === "string")
      .map((value) => ({ value, decision: ompDecisionForOption(value) }));
    const toolName = frameString(frame, "title") ?? frameString(frame, "toolName") ?? "tool";
    const prompt = frameString(frame, "message") ?? frameString(frame, "title");
    const now = yield* DateTime.now;
    const requestId = runtimeRequestIdFromNative(nativeRequestId);
    const nodeId = IdAllocator.derive.approvalNode({ requestId });
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: turn.providerTurn.id,
      nativeRequestRef: driverRef(driver, nativeRequestId, "strong"),
      kind: "permission",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: input.providerSessionId },
      createdAt: now,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      parentNodeId: turn.turnInput.rootNodeId,
      rootNodeId: turn.turnInput.rootNodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: driverRef(driver, nativeRequestId, "strong"),
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const item: OrchestrationV2TurnItem = {
      id: IdAllocator.derive.approvalTurnItem({ requestId }),
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      nodeId,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: driverRef(driver, nativeRequestId, "strong"),
      parentItemId: null,
      ordinal: turn.nextItemOrdinal++,
      status: "waiting",
      title: toolName,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "approval_request",
      requestId,
      requestKind: "permission",
      ...(prompt === undefined ? {} : { prompt }),
      options: approvalOptionsFor(toolName),
    };
    state.runtimeRequests.set(nativeRequestId, {
      request,
      item,
      node,
      nativeRequestId,
      toolName,
      choices,
      answering: false,
    });
    yield* input.emit({ type: "node.updated", driver, node });
    yield* input.emit({
      type: "runtime_request.updated",
      driver,
      threadId: turn.turnInput.threadId,
      runtimeRequest: request,
    });
    yield* input.emit({ type: "turn_item.updated", driver, turnItem: item });
  });

  const applyThinking = (level: string): Effect.Effect<void> =>
    Effect.sync(() => {
      state.appliedThinking = level;
    });

  const handleFrame = (frame: OmpRpcFrame): Effect.Effect<void> => {
    const type = frameString(frame, "type");
    switch (type) {
      case "message_update":
        return handleMessageUpdate(frame);
      case "message_end":
        return handleMessageEndFrame(frame);
      case "tool_execution_start":
        return handleToolExecution(frame, "start");
      case "tool_execution_end":
        return handleToolExecution(frame, "end");
      case "prompt_result":
        return handlePromptResult(frame);
      case "agent_end":
        return handleAgentEnd(frame);
      // Compaction (D9): hint lines into the transcript + ContextWindowMeter refresh. Frames
      // landing between turns are buffered above (routeFrame) and replayed at the next turn.
      case "auto_compaction_start":
      case "manual_compaction_start":
        return handleCompactionStart(frame);
      case "auto_compaction_end":
      case "manual_compaction_end":
        return handleCompactionEnd(frame);
      case "model_changed": {
        // omp changed its model (spec §6: report-and-passthrough): sync thread metadata from
        // the frame's `model` slug or `provider`+`modelId` pair; unknown shapes stay tolerated.
        const slug =
          frameString(frame, "model") ??
          (() => {
            const provider = frameString(frame, "provider");
            const modelId = frameString(frame, "modelId");
            return provider === undefined || modelId === undefined
              ? undefined
              : `${provider}/${modelId}`;
          })();
        if (slug === undefined || slug === state.appliedModel?.slug) return Effect.void;
        const parsed = parseOmpModelSlug(slug);
        return parsed === null ? Effect.void : applyModel(parsed);
      }
      case "extension_ui_request":
        return handleExtensionUiRequest(frame);
      case "session_settled":
        // Turn terminal already flipped the thread to idle; this confirms no queued/background
        // work remains and the session is ready for the next turn.
        return Effect.void;
      case "queue_update": {
        const turn = state.active;
        if (turn === null) return Effect.void;
        const steering = Array.isArray(frame["steering"]) ? frame["steering"] : [];
        const followUp = Array.isArray(frame["followUp"]) ? frame["followUp"] : [];
        const pending = steering.length + followUp.length > 0;
        return input.emit({
          type: "background_work.updated",
          driver,
          providerTurnId: turn.providerTurn.id,
          pending,
        });
      }
      // Tolerated for later tickets (#23): subagent presentation. Ignored, never
      // an error (spec §5.5). model_changed (#17), extension_ui_request (#16) and compaction
      // (#20) project in this switch; available_commands_update is projected at the adapter's
      // frame entry (#19), before turn scoping, so it never reaches this switch.
      default:
        return Effect.void;
    }
  };

  return {
    state,
    handleFrame,
    flushOrphanFrames: Effect.suspend(() => {
      const orphaned = state.orphanFrames;
      if (orphaned.length === 0) return Effect.void;
      state.orphanFrames = [];
      // Approval dialogs belong to the turn that was active when they arrived; a stale one
      // replayed into a later turn would attach to the wrong run. omp resolves its own
      // dialogs (timeout/cancel), so dropping the stale request is the fail-safe projection.
      const replayable = orphaned.filter((frame) => !isOmpApprovalRequestFrame(frame));
      if (replayable.length === 0) return Effect.void;
      return Effect.forEach(replayable, handleFrame, { discard: true });
    }),
    beginTurn: ({ providerTurn, turnInput }) => {
      const nativeTurnId = `${providerTurn.id}:t${turnInput.providerTurnOrdinal}`;
      const turn: OmpActiveTurn = {
        providerTurn,
        turnInput,
        nativeTurnId,
        streamItems: new Map(),
        tools: new Map(),
        activeCompaction: null,
        awaitingAgentEnd: false,
        deferredPromptResult: null,
        nextItemOrdinal: 1,
      };
      state.active = turn;
      return turn;
    },
    finalizeTurn,
    markThreadStatus: (status: OrchestrationV2ProviderThread["status"]) => updateThread({ status }),
    applyModel,
    applyThinking,
  };
};
