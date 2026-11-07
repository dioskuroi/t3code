// PROTOTYPE, throwaway (wayfinder #8): stub provider adapter，伪造最小合法事件序列。
// turn 生命线：provider_turn.updated(running, runAttemptId=attemptId) → 流式
// turn_item/message → provider_turn.updated(completed) → turn.terminal(completed)。
// user message / root node 由 orchestrator 自建，adapter 不发。
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { STUB_PROVIDER } from "./kind.ts";

const STUB_DRIVER = STUB_PROVIDER;

// 保守 truth 表：只申报 stub 真正做到的事。
const StubProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface StubThreadState {
  providerThread: OrchestrationV2ProviderThread;
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  active: StubActiveTurn | null;
}

interface StubActiveTurn {
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly fiber: Fiber.Fiber<void>;
}

const providerRef = (nativeId: string): OrchestrationV2ProviderThread["nativeThreadRef"] => ({
  driver: STUB_DRIVER,
  nativeId,
  strength: "strong",
});

const CHUNK_DELAY_MS = 150;

export interface StubAdapterOptions {
  readonly instanceId: ProviderInstanceId;
}

export const makeStubAdapterV2 = (options: StubAdapterOptions) =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: STUB_DRIVER,
    getCapabilities: Effect.fn("StubAdapter.getCapabilities")(function () {
      return Effect.succeed(StubProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("StubAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("StubAdapter.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const now = yield* DateTime.now;
      const cwd = input.runtimePolicy.cwd ?? "/";
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: STUB_DRIVER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: StubProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const threads = new Map<string, StubThreadState>();

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
      ) {
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, status, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: STUB_DRIVER,
          providerSession: sessionEntity,
        });
      });

      const updateThread = Effect.fnUntraced(function* (
        state: StubThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        const updatedAt = yield* DateTime.now;
        state.providerThread = { ...state.providerThread, ...patch, updatedAt };
        yield* emit({
          type: "provider_thread.updated",
          driver: STUB_DRIVER,
          providerThread: state.providerThread,
        });
      });

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const nativeThreadId =
          threadInput.existingProviderThread?.nativeThreadRef?.nativeId ??
          `stub-${threadInput.threadId}`;
        const existing = threads.get(nativeThreadId);
        if (
          existing !== undefined &&
          existing.providerThread.appThreadId === threadInput.threadId
        ) {
          if (threadInput.modelSelection.model !== sessionEntity.model) {
            const updatedAt = yield* DateTime.now;
            sessionEntity = {
              ...sessionEntity,
              model: threadInput.modelSelection.model,
              updatedAt,
            };
            yield* emit({
              type: "provider_session.updated",
              driver: STUB_DRIVER,
              providerSession: sessionEntity,
            });
          }
          return existing.providerThread;
        }
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread = {
          id: IdAllocator.derive.providerThread({ driver: STUB_DRIVER, nativeThreadId }),
          driver: STUB_DRIVER,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: threadInput.threadId,
          ownerNodeId: null,
          nativeThreadRef: providerRef(nativeThreadId),
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [],
          contextUsage: null,
          nativeMetadata: null,
          goal: null,
          createdAt,
          updatedAt: createdAt,
        };
        threads.set(nativeThreadId, {
          providerThread,
          turns: [],
          messages: [],
          active: null,
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: STUB_DRIVER,
          providerThread,
        });
        return providerThread;
      });

      // 终结一个 turn：幂等（active 已清则跳过），顺序照抄 pi finalizeTurn。
      const finalizeTurn = Effect.fnUntraced(function* (
        state: StubThreadState,
        status: "completed" | "interrupted",
      ) {
        const turn = state.active;
        if (turn === null) return;
        state.active = null;
        const completedAt = yield* DateTime.now;
        const finalTurn: OrchestrationV2ProviderTurn = {
          ...turn.providerTurn,
          status,
          completedAt,
        };
        state.turns = [...state.turns, finalTurn];
        yield* emit({
          type: "provider_turn.updated",
          driver: STUB_DRIVER,
          threadId: turn.turnInput.threadId,
          providerTurn: finalTurn,
        });
        yield* updateThread(state, { status: "idle" });
        yield* updateSession("ready");
        yield* emit({
          type: "turn.terminal",
          driver: STUB_DRIVER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
      });

      // 回显体：流式分片。
      const echoChunks = (text: string): ReadonlyArray<string> => {
        const body = `📗 stub echo (${text.length} chars):\n\n${text}`;
        const parts = Math.min(6, Math.max(1, Math.ceil(body.length / 80)));
        const size = Math.ceil(body.length / parts);
        return Array.from({ length: parts }, (_, i) => body.slice(i * size, (i + 1) * size)).filter(
          (chunk) => chunk.length > 0,
        );
      };

      const runEchoTurn = Effect.fnUntraced(function* (
        state: StubThreadState,
        turn: {
          readonly providerTurn: OrchestrationV2ProviderTurn;
          readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
        },
      ) {
        const { turnInput } = turn;
        const nativeTurnId = turn.providerTurn.nativeTurnRef?.nativeId ?? turn.providerTurn.id;
        const nativeItemId = `${nativeTurnId}:assistant`;
        const itemIds = {
          item: IdAllocator.derive.turnItemFromProviderItem({ driver: STUB_DRIVER, nativeItemId }),
          message: IdAllocator.derive.messageFromProviderItem({
            driver: STUB_DRIVER,
            nativeItemId,
          }),
          node: IdAllocator.derive.nodeFromProviderItem({ driver: STUB_DRIVER, nativeItemId }),
        };
        const startedAt = yield* DateTime.now;
        let emitted = "";
        for (const chunk of echoChunks(turnInput.message.text)) {
          emitted += chunk;
          const streaming = true;
          yield* Effect.sleep(`${CHUNK_DELAY_MS} millis`);
          yield* emit({
            type: "node.updated",
            driver: STUB_DRIVER,
            node: {
              id: itemIds.node,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              parentNodeId: turnInput.rootNodeId,
              rootNodeId: turnInput.rootNodeId,
              kind: "assistant_message",
              status: "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt: null,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: STUB_DRIVER,
            turnItem: {
              id: itemIds.item,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: itemIds.node,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              parentItemId: null,
              ordinal: 0,
              status: "running",
              title: null,
              startedAt,
              completedAt: null,
              updatedAt: yield* DateTime.now,
              type: "assistant_message",
              messageId: itemIds.message,
              text: emitted,
              streaming,
            } satisfies OrchestrationV2TurnItem,
          });
          yield* emit({
            type: "message.updated",
            driver: STUB_DRIVER,
            message: {
              id: itemIds.message,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: itemIds.node,
              role: "assistant",
              text: emitted,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: startedAt,
              updatedAt: yield* DateTime.now,
            } satisfies OrchestrationV2ConversationMessage,
          });
        }
        // 终片：streaming false。
        const finishedAt = yield* DateTime.now;
        yield* emit({
          type: "node.updated",
          driver: STUB_DRIVER,
          node: {
            id: itemIds.node,
            threadId: turnInput.threadId,
            runId: turnInput.runId,
            parentNodeId: turnInput.rootNodeId,
            rootNodeId: turnInput.rootNodeId,
            kind: "assistant_message",
            status: "completed",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt: finishedAt,
          },
        });
        const finalMessage: OrchestrationV2ConversationMessage = {
          id: itemIds.message,
          threadId: turnInput.threadId,
          runId: turnInput.runId,
          nodeId: itemIds.node,
          role: "assistant",
          text: emitted,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: startedAt,
          updatedAt: finishedAt,
        };
        state.messages = [...state.messages, finalMessage];
        yield* emit({
          type: "turn_item.updated",
          driver: STUB_DRIVER,
          turnItem: {
            id: itemIds.item,
            threadId: turnInput.threadId,
            runId: turnInput.runId,
            nodeId: itemIds.node,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt,
            completedAt: finishedAt,
            updatedAt: finishedAt,
            type: "assistant_message",
            messageId: itemIds.message,
            text: emitted,
            streaming: false,
          } satisfies OrchestrationV2TurnItem,
        });
        yield* emit({
          type: "message.updated",
          driver: STUB_DRIVER,
          message: finalMessage,
        });
        yield* finalizeTurn(state, "completed");
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: STUB_DRIVER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        getModelContextWindow: () => 8_192,
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: STUB_DRIVER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: STUB_DRIVER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: Effect.fn("StubAdapter.startTurn")(function* (turnInput) {
          const state = threads.get(turnInput.providerThread.nativeThreadRef?.nativeId ?? "");
          if (state === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: STUB_DRIVER,
              detail: "Stub turn requested for an unregistered thread",
            });
          }
          if (state.active !== null) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: STUB_DRIVER,
              detail: `Stub thread ${turnInput.providerThread.id} already has an active turn`,
              reason: "previous_turn_active",
            });
          }
          const startedAt = yield* DateTime.now;
          const nativeTurnId = `${turnInput.providerThread.nativeThreadRef?.nativeId ?? "stub"}:t${turnInput.providerTurnOrdinal}:r${turnInput.runOrdinal}`;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: IdAllocator.derive.providerTurn({ driver: STUB_DRIVER, nativeTurnId }),
            providerThreadId: state.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: { driver: STUB_DRIVER, nativeId: nativeTurnId, strength: "weak" },
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          yield* emit({
            type: "provider_turn.updated",
            driver: STUB_DRIVER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread(state, { status: "active" });
          yield* updateSession("running");
          const fiber = yield* runEchoTurn(state, { providerTurn, turnInput }).pipe(
            Effect.catchDefect((defect) => Effect.logWarning("Stub echo turn defect", { defect })),
            Effect.forkIn(scope),
          );
          state.active = { providerTurn, turnInput, fiber };
        }),
        steerTurn: () => Effect.void,
        interruptTurn: Effect.fn("StubAdapter.interruptTurn")(function* (interruptInput) {
          const state = threads.get(interruptInput.providerThread.nativeThreadRef?.nativeId ?? "");
          if (state === undefined || state.active === null) return;
          const fiber = state.active.fiber;
          // fiber 的 finalize 与这里的 finalize 竞争；active 检查使其幂等。
          yield* Fiber.interrupt(fiber);
          yield* finalizeTurn(state, "interrupted");
        }),
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: Effect.fn("StubAdapter.readThreadSnapshot")(function* (snapshotInput) {
          const nativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId ?? "";
          const state = threads.get(nativeId);
          if (state === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: STUB_DRIVER,
              providerThreadId: snapshotInput.providerThread.id,
              cause: new Error("Stub thread not registered in this session"),
            });
          }
          return {
            providerThread: state.providerThread,
            providerTurns: state.turns,
            messages: state.messages,
            runtimeRequests: [],
          };
        }),
        rollbackThread: Effect.fn("StubAdapter.rollbackThread")(function* (rollbackInput) {
          const nativeId = rollbackInput.providerThread.nativeThreadRef?.nativeId ?? "";
          const state = threads.get(nativeId);
          if (state === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: STUB_DRIVER,
              providerThreadId: rollbackInput.providerThread.id,
              cause: new Error("Stub thread not registered in this session"),
            });
          }
          // 内存态整体丢弃（stub 不保存真实历史）。
          state.turns = [];
          state.messages = [];
          yield* updateThread(state, { nativeConversationHeadRef: null });
          return {
            providerThread: state.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          };
        }),
        forkThread: Effect.fn("StubAdapter.forkThread")(function* (forkInput) {
          const nativeThreadId = `stub-fork-${forkInput.targetThreadId}`;
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            id: IdAllocator.derive.providerThread({ driver: STUB_DRIVER, nativeThreadId }),
            driver: STUB_DRIVER,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: forkInput.targetThreadId,
            ownerNodeId: forkInput.ownerNodeId ?? null,
            nativeThreadRef: providerRef(nativeThreadId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: forkInput.sourceProviderThread.id,
              ...(forkInput.providerTurnId === undefined
                ? {}
                : { providerTurnId: forkInput.providerTurnId }),
            },
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt,
            updatedAt: createdAt,
          };
          threads.set(nativeThreadId, {
            providerThread,
            turns: [],
            messages: [],
            active: null,
          });
          yield* emit({
            type: "provider_thread.updated",
            driver: STUB_DRIVER,
            providerThread,
          });
          return providerThread;
        }),
      };

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const state of threads.values()) {
            if (state.active !== null) {
              yield* Fiber.interrupt(state.active.fiber);
            }
          }
          yield* Queue.end(events);
        }),
      );

      yield* emit({
        type: "provider_session.updated",
        driver: STUB_DRIVER,
        providerSession: sessionEntity,
      });

      return runtime;
    }),
  });
