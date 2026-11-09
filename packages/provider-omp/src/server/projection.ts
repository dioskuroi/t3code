// omp frame → ProviderAdapterV2Event projection (spec §5.5, one per thread/process pair).
// Contract hard constraints (#8): provider_turn.updated carries runAttemptId = turnInput.attemptId,
// no user message / root node is ever emitted, there is no "starting" state, terminal success
// carries { status, failure: null, runOrdinal, threadDisposition }, ids come from IdAllocator.
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
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
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly nativeTurnId: string;
  readonly streamItems: Map<string, OmpStreamItem>;
  readonly tools: Map<string, OmpToolItem>;
  /** An agent_end with isTerminal:false arrived; terminal waits for the next real agent_end. */
  awaitingAgentEnd: boolean;
  deferredPromptResult: OmpRpcFrame | null;
  nextItemOrdinal: number;
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
}

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
    kind: "assistant_message" | "reasoning" | "tool_call",
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
    const finalTurn: OrchestrationV2ProviderTurn = {
      ...turn.providerTurn,
      status: status === "failed" ? "failed" : status,
      completedAt,
    };
    state.turns = [...state.turns, finalTurn];
    yield* input.emit({
      type: "provider_turn.updated",
      driver,
      threadId: turn.turnInput.threadId,
      providerTurn: finalTurn,
    });
    yield* updateThread({ status: status === "failed" ? "error" : "idle" });
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

  const handleFrame = (frame: OmpRpcFrame): Effect.Effect<void> => {
    const type = frameString(frame, "type");
    switch (type) {
      case "message_update":
        return handleMessageUpdate(frame);
      case "tool_execution_start":
        return handleToolExecution(frame, "start");
      case "tool_execution_end":
        return handleToolExecution(frame, "end");
      case "prompt_result":
        return handlePromptResult(frame);
      case "agent_end":
        return handleAgentEnd(frame);
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
      // Tolerated for later tickets (#16/#20/#21…): approvals, compaction, subagent
      // presentation. Ignored, never an error (spec §5.5). model_changed projects in this
      // switch (#17); available_commands_update is projected into the slash-command directory
      // at the adapter's frame entry (#19), before turn scoping, so it never reaches this switch.
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
      return Effect.forEach(orphaned, handleFrame, { discard: true });
    }),
    beginTurn: ({ providerTurn, turnInput }) => {
      const nativeTurnId = `${providerTurn.id}:t${turnInput.providerTurnOrdinal}`;
      const turn: OmpActiveTurn = {
        providerTurn,
        turnInput,
        nativeTurnId,
        streamItems: new Map(),
        tools: new Map(),
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
  };
};
