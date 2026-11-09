// omp adapter lifeline (spec §5.4/5.5/5.6, tickets #15/#17/#19): one t3code thread drives
// exactly one `omp --mode rpc` child; lazy spawn at the first prompt, recovery always via
// explicit sessionPath. Frames project onto ProviderAdapterV2Events in projection.ts; the
// slash-command directory (#19) projects at the frame entry; approvals (#16) and #18 have tickets.
import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { makeOmpRpcClient, type OmpRpcClient } from "./rpc/client.ts";
import {
  createOmpThreadProjection,
  OMP_INHERIT_MODEL_SLUG,
  parseOmpModelSlug,
  ompSlashCommandsFromFrame,
  type OmpModelRef,
  type OmpThreadProjection,
} from "./projection.ts";
import { OMP_PROVIDER } from "./kind.ts";

// Spec §7 (ADR-0004): subagents true/closable but not forkable/waitable, reasoning streams,
// everything unmapped stays unpresented (false).
const OmpProviderCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
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
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
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
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: true,
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
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

// Spec §6: t3code RuntimeMode → omp --approval-mode; "auto" never declares a native mode
// (stored auto degrades to Supervised server-side).
const OMP_APPROVAL_MODE_BY_RUNTIME_MODE = {
  "approval-required": "always-ask",
  "auto-accept-edits": "write",
  auto: undefined,
  "full-access": "yolo",
} as const;

const IMAGE_DATA_URL_SEPARATOR = ",base64,";

// ChatImageAttachment carries its pixels as a data: URL snapshot source; file attachments
// degrade to a path note in the prompt text (spec §7 attachment rules).
const turnMessageParts = (
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
): { message: string; images?: ReadonlyArray<{ data: string }> } => {
  const images: Array<{ data: string }> = [];
  let text = message.text;
  for (const attachment of message.attachments) {
    if (
      attachment.type === "image" &&
      "source" in attachment &&
      typeof attachment.source === "object" &&
      attachment.source !== null &&
      "dataUrl" in attachment.source
    ) {
      const dataUrl: string | undefined = attachment.source.dataUrl as string | undefined;
      const separator = dataUrl?.indexOf(IMAGE_DATA_URL_SEPARATOR) ?? -1;
      if (dataUrl !== undefined && separator >= 0) {
        images.push({ data: dataUrl.slice(separator + IMAGE_DATA_URL_SEPARATOR.length) });
        continue;
      }
    }
    text += `\n\n[attachment: ${attachment.name} (${attachment.mimeType})]`;
  }
  return images.length === 0 ? { message: text } : { message: text, images };
};

interface OmpClientHolder {
  client: OmpRpcClient | null;
  /** Dedicated child-process scope, closed after the drain-to-EOF close resolves. */
  scope: Scope.Closeable | null;
  /** Set while an orderly drain (session teardown) is in flight, so exits stay silent. */
  closing: boolean;
  /** True once the child exited for any reason; a dead client must never be reused. */
  exited: boolean;
}

interface OmpThreadState {
  readonly projection: OmpThreadProjection;
  readonly client: OmpClientHolder;
  broken: boolean;
  /** Armed idle-reclaim timer fiber (spec §5.6); null when no timer is pending. */
  idleReclaimFiber: Fiber.Fiber<void> | null;
}

/** Non-directory frames forwarded to the projection before their turn went active (fake-harness races). */
const routeFrame = (thread: OmpThreadState, frame: Record<string, unknown>): Effect.Effect<void> =>
  thread.projection.state.active === null
    ? Effect.sync(() => {
        thread.projection.state.orphanFrames = [...thread.projection.state.orphanFrames, frame];
      })
    : thread.projection.handleFrame(frame);

const protocolError = (detail: string, cause?: unknown, reason?: "previous_turn_active") =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: OMP_PROVIDER,
    detail,
    ...(cause === undefined ? {} : { cause }),
    ...(reason === undefined ? {} : { reason }),
  });

// Spec §5.6: the omp child is reclaimed after 5 idle minutes past the last settled turn.
// Inject an `idleTimeoutMs`/`clock` into makeOmpAdapterV2 to tune or fast-forward the timer.
export const OMP_IDLE_RECLAIM_TIMEOUT_MS = 5 * 60_000;

/**
 * Fail-closed model guidance (#17): omp's raw error plus an explicit re-selection hint. Shared
 * by set_model selections and switch_session restores so both surface the same contract.
 */
const modelRestoreError = (what: string, model: OmpModelRef | null, cause: unknown) => {
  const message = (cause as { message?: unknown } | null | undefined)?.message;
  const detail =
    typeof message === "string" && message.trim() !== "" ? message : "omp request failed";
  return protocolError(
    model === null
      ? what
      : `omp could not apply model ${model.slug}: ${detail}. ` +
          "Re-select a model from the refreshed provider catalog; T3 never falls back to a default model.",
    cause,
  );
};

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (input: {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
  /** Resolved executable; defaults to `omp` (PATH discovery, spec §5.3). */
  readonly command?: string | undefined;
  /** Idle window before the omp child is reclaimed; defaults to OMP_IDLE_RECLAIM_TIMEOUT_MS. */
  readonly idleTimeoutMs?: number | undefined;
  /** Clock driving the idle-reclaim timer; defaults to the ambient Clock (tests inject one). */
  readonly clock?: Clock.Clock | undefined;
}) {
  // The spawner is captured once at driver creation; the session runtime supplies it to each
  // omp process spawn (spec §5.2: cwd = project root, env inherited from the server process).
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: input.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(function* () {
      return OmpProviderCapabilities;
    }),
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(function* () {
      return turnScopedSelectionTransition();
    }),
    openSession: Effect.fn("OmpAdapter.openSession")(function* (sessionInput) {
      const services = yield* Effect.context<never>();
      const now = yield* DateTime.now;
      const cwd = sessionInput.runtimePolicy.cwd ?? process.cwd();
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver: OMP_PROVIDER,
        providerInstanceId: input.instanceId,
        status: "ready",
        cwd,
        model: sessionInput.modelSelection.model,
        capabilities: OmpProviderCapabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const threads = new Map<string, OmpThreadState>();
      // Reclaim timers fork into the session scope so teardown interrupts them (#18).
      const sessionScope = yield* Effect.scope;
      const idleTimeoutMs = input.idleTimeoutMs ?? OMP_IDLE_RECLAIM_TIMEOUT_MS;
      const idleSleep =
        input.clock === undefined
          ? Effect.sleep(Duration.millis(idleTimeoutMs))
          : Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
              Effect.provideService(Clock.Clock, input.clock),
            );

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError?: string | null,
      ) {
        const updatedAt = yield* DateTime.now;
        sessionEntity = {
          ...sessionEntity,
          status,
          updatedAt,
          lastError: lastError === undefined ? sessionEntity.lastError : lastError,
        };
        yield* emit({
          type: "provider_session.updated",
          driver: OMP_PROVIDER,
          providerSession: sessionEntity,
        });
      });

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const existingThreadId = threadInput.existingProviderThread?.id;
        const existing = existingThreadId === undefined ? undefined : threads.get(existingThreadId);
        if (existing !== undefined) return existing.projection.state.providerThread;
        const createdAt = yield* DateTime.now;
        const nativeThreadId = `omp-${threadInput.threadId}`;
        const providerThread: OrchestrationV2ProviderThread =
          threadInput.existingProviderThread ?? {
            id: IdAllocator.derive.providerThread({ driver: OMP_PROVIDER, nativeThreadId }),
            driver: OMP_PROVIDER,
            providerInstanceId: input.instanceId,
            providerSessionId: sessionInput.providerSessionId,
            appThreadId: threadInput.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
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
        const projectionState = {
          providerThread,
          turns: [],
          messages: [],
          active: null,
          orphanFrames: [],
          nativeSession: null,
          appliedModel: null,
        };
        const client: OmpClientHolder = {
          client: null,
          scope: null,
          closing: false,
          exited: false,
        };
        const projection = createOmpThreadProjection({
          driver: OMP_PROVIDER,
          instanceId: input.instanceId,
          providerSessionId: sessionInput.providerSessionId,
          state: projectionState,
          // Arm the idle-reclaim timer before the terminal reaches the events queue: any
          // cancel (a follow-up prompt) is then causally ordered after the arm (#18).
          emit: (event) =>
            event.type === "turn.terminal"
              ? Effect.andThen(
                  Effect.suspend(() => {
                    const thread = threads.get(providerThread.id);
                    return thread === undefined ? Effect.void : armIdleReclaim(thread);
                  }),
                  emit(event),
                )
              : emit(event),
          updateSession,
          // Transport only: meter reads (D9) cap at 2s and swallow failures inside the
          // projection — a dead process must never fail a turn finalization.
          readSessionState: Effect.suspend(() => {
            const rpc = client.client;
            return rpc === null ? Effect.void : rpc.request("get_state");
          }),
        });
        threads.set(providerThread.id, {
          projection,
          client,
          broken: false,
          idleReclaimFiber: null,
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_PROVIDER,
          providerThread,
        });
        return providerThread;
      });

      const spawnArgs = (runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) => {
        const approvalMode = OMP_APPROVAL_MODE_BY_RUNTIME_MODE[runtimePolicy.runtimeMode];
        return approvalMode === undefined
          ? ["--mode", "rpc"]
          : ["--mode", "rpc", "--approval-mode", approvalMode];
      };

      // Orderly child disposal (spec §5.6 / #15 deadlock pattern): close stdin, keep reading
      // stdout to EOF, then close the child's dedicated scope. Uninterruptible so a racing
      // prompt cancellation cannot strand a half-drained child.
      const disposeClient = (thread: OmpThreadState): Effect.Effect<number | null> =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const holder = thread.client;
            if (holder.client === null) return null;
            holder.closing = true;
            const exitCode = yield* holder.client.close;
            if (holder.scope !== null) {
              yield* Scope.close(holder.scope, Exit.succeed(undefined)).pipe(Effect.ignore);
            }
            holder.client = null;
            holder.scope = null;
            holder.closing = false;
            return exitCode;
          }),
        );

      const cancelIdleReclaim = Effect.fn("OmpAdapter.cancelIdleReclaim")(function* (
        thread: OmpThreadState,
      ) {
        const fiber = thread.idleReclaimFiber;
        thread.idleReclaimFiber = null;
        if (fiber !== null) yield* Fiber.interrupt(fiber);
      });

      const armIdleReclaim = Effect.fn("OmpAdapter.armIdleReclaim")(function* (
        thread: OmpThreadState,
      ) {
        yield* cancelIdleReclaim(thread);
        thread.idleReclaimFiber = yield* Effect.gen(function* () {
          yield* idleSleep;
          const holder = thread.client;
          if (holder.client === null) return;
          const threadId = thread.projection.state.providerThread.id;
          const exitCode = yield* disposeClient(thread);
          yield* Effect.logInfo(
            `omp process for provider thread ${threadId} reclaimed after ${String(idleTimeoutMs)}ms idle (exit ${String(exitCode)})`,
          );
        }).pipe(Effect.forkIn(sessionScope));
      });

      const ensureClient = Effect.fn("OmpAdapter.ensureClient")(function* (
        thread: OmpThreadState,
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
      ) {
        if (thread.client.client !== null) {
          // A crashed or reclaimed-away child is never reused: drain whatever is left of it
          // and respawn below (crash recovery, spec §5.6 D7).
          if (!thread.broken && !thread.client.exited) return;
          yield* disposeClient(thread);
        }
        const state = thread.projection.state;
        const sessionPath = state.providerThread.nativeThreadRef?.nativeId ?? null;
        thread.client.closing = false;
        // The child's fibers get a dedicated scope: the session scope's teardown interrupts
        // fibers before the drain-to-EOF close can finish, leaving the child's stdin open.
        const clientScope = yield* Scope.make();
        const client = yield* makeOmpRpcClient({
          command: input.command ?? "omp",
          args: spawnArgs(runtimePolicy),
          cwd,
          // Child stderr goes to the T3 server log (spec §5.2, #18).
          onStderr: (chunk) => {
            const text = chunk.trim();
            if (text === "") return;
            Effect.runForkWith(services)(
              Effect.logWarning(`omp stderr [${state.providerThread.id}]: ${text}`),
            );
          },
          onEvent: (frame) => {
            // Directory frames project immediately regardless of turn state (spec §5.5/§7):
            // omp pushes the startup catalog right after open_session, before any turn.
            const slashCommands = ompSlashCommandsFromFrame(frame);
            Effect.runForkWith(services)(
              slashCommands === undefined
                ? routeFrame(thread, frame)
                : emit({
                    type: "provider_slash_commands.updated",
                    driver: OMP_PROVIDER,
                    providerThreadId: thread.projection.state.providerThread.id,
                    slashCommands: [...slashCommands],
                  }),
            );
          },
          onExit: (exit) => {
            thread.client.exited = true;
            if (thread.client.closing) return;
            // Crash reporting must not be silent (spec §5.6): the thread disconnects and the
            // active turn (if any) ends interrupted so the orchestrator sees a terminal. The
            // next prompt respawns onto the same session via switch_session.
            thread.broken = true;
            Effect.runForkWith(services)(
              Effect.gen(function* () {
                yield* thread.projection.finalizeTurn("interrupted");
                yield* thread.projection.markThreadStatus("error");
                yield* Effect.logWarning(
                  `omp process for provider thread ${state.providerThread.id} exited (code ${String(exit.exitCode)})`,
                );
              }),
            );
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Scope.Scope, clientScope),
          Effect.mapError((cause) =>
            protocolError(
              sessionPath === null
                ? "Failed to spawn or initialize the omp process"
                : `Failed to respawn the omp process for session ${sessionPath}`,
              cause,
            ),
          ),
        );
        thread.client.client = client;
        thread.client.scope = clientScope;
        // A successful spawn clears the disconnect from a previous crash.
        thread.broken = false;
        if (sessionPath === null) {
          const opened = (yield* client
            .request("open_session", {})
            .pipe(Effect.mapError((cause) => protocolError("open_session failed", cause)))) as {
            sessionId?: unknown;
            sessionFile?: unknown;
          };
          if (
            typeof opened?.sessionId !== "string" ||
            typeof opened.sessionFile !== "string" ||
            opened.sessionFile === ""
          ) {
            return yield* protocolError("open_session returned no sessionId/sessionFile");
          }
          state.nativeSession = { sessionId: opened.sessionId, sessionFile: opened.sessionFile };
          const updatedAt = yield* DateTime.now;
          state.providerThread = {
            ...state.providerThread,
            nativeThreadRef: {
              driver: OMP_PROVIDER,
              nativeId: opened.sessionFile,
              strength: "strong",
            },
            updatedAt,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread: state.providerThread,
          });
          return;
        }
        // Fail-closed recovery: always the explicit sessionPath, never "continue latest".
        // A thread that selected a model carries it in thread metadata (#17): pass the
        // provider+modelId pair so omp restores exactly that model — an unknown pair fails the
        // restore (surfaced fail-closed), never a silent default fallback.
        const restoreModel =
          sessionPath === null
            ? null
            : parseOmpModelSlug(state.providerThread.nativeMetadata?.modelSelection?.model ?? "");
        yield* client
          .request(
            "switch_session",
            restoreModel === null
              ? { sessionPath }
              : { sessionPath, provider: restoreModel.provider, modelId: restoreModel.modelId },
          )
          .pipe(
            Effect.tap(() =>
              restoreModel === null
                ? Effect.void
                : Effect.sync(() => {
                    state.appliedModel = restoreModel;
                  }),
            ),
            Effect.mapError((cause) =>
              modelRestoreError(`switch_session failed for ${sessionPath}`, restoreModel, cause),
            ),
          );
      });

      const applyTurnModel = Effect.fn("OmpAdapter.applyTurnModel")(function* (
        thread: OmpThreadState,
        modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
      ) {
        const state = thread.projection.state;
        const slug = modelSelection.model;
        // "default" never drives set_model: a fresh thread follows omp's own resolution, and
        // omp exposes no unset-model RPC, so a later default pick cannot restore that state.
        if (slug === OMP_INHERIT_MODEL_SLUG || slug === state.appliedModel?.slug) return;
        const parsed = parseOmpModelSlug(slug);
        if (parsed === null) {
          return yield* protocolError(`omp model '${slug}' must use provider/model format`);
        }
        yield* thread.client
          .client!.request("set_model", {
            provider: parsed.provider,
            modelId: parsed.modelId,
          })
          .pipe(
            // Applied model lands in thread metadata only after omp confirmed the selection.
            Effect.tap(() => thread.projection.applyModel(parsed)),
            Effect.mapError((cause) => modelRestoreError("set_model failed", parsed, cause)),
          );
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: input.instanceId,
        driver: OMP_PROVIDER,
        providerSessionId: sessionInput.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: OMP_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: Effect.fn("OmpAdapter.resumeThread")(function* (
          threadInput: Parameters<
            ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
          >[0],
        ) {
          const providerThread = yield* registerThread({
            threadId:
              threadInput.threadId ??
              threadInput.providerThread.appThreadId ??
              sessionInput.threadId,
            modelSelection: threadInput.modelSelection ?? sessionInput.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? sessionInput.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          });
          const thread = threads.get(providerThread.id);
          if (thread === undefined) return providerThread;
          // An explicit resume is prompt-like activity: it cancels any pending reclaim.
          yield* cancelIdleReclaim(thread);
          // ensureClient switches to the explicit sessionPath when the thread has one
          // (fail-closed recovery, spec §3/§5.4); a thread without a session only respawns.
          yield* ensureClient(thread, threadInput.runtimePolicy ?? sessionInput.runtimePolicy).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: OMP_PROVIDER,
                  providerSessionId: sessionInput.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          );
          return thread.projection.state.providerThread;
        }),
        startTurn: Effect.fn("OmpAdapter.startTurn")(function* (turnInput) {
          const thread = threads.get(turnInput.providerThread.id);
          if (thread === undefined) {
            return yield* protocolError("omp turn requested for an unregistered thread");
          }
          if (thread.projection.state.active !== null) {
            return yield* protocolError(
              `omp thread ${turnInput.providerThread.id} already has an active turn`,
              undefined,
              "previous_turn_active",
            );
          }
          // A new prompt is exactly the activity the idle reclaim waits for: cancel it
          // before reusing/respawning the child (spec §5.6).
          yield* cancelIdleReclaim(thread);
          const startedAt = yield* DateTime.now;
          const nativeTurnId = `${turnInput.providerThread.id}:t${turnInput.providerTurnOrdinal}:r${turnInput.runOrdinal}`;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: IdAllocator.derive.providerTurn({ driver: OMP_PROVIDER, nativeTurnId }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: { driver: OMP_PROVIDER, nativeId: nativeTurnId, strength: "weak" },
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          yield* ensureClient(thread, turnInput.runtimePolicy);
          // Model passthrough (#17): startTurn only runs on an idle thread, which is exactly
          // omp's set_model window — a mid-turn switch cannot reach the process (the turn
          // guard above rejects a second start, and no other path mutates the model).
          yield* applyTurnModel(thread, turnInput.modelSelection);
          thread.projection.beginTurn({ providerTurn, turnInput });
          // Contract: provider_turn.updated(running, runAttemptId) lands before any projected
          // frame (orphan replay included), so the orchestrator always sees the turn first.
          yield* emit({
            type: "provider_turn.updated",
            driver: OMP_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread: { ...thread.projection.state.providerThread, status: "active" },
          });
          yield* updateSession("running");
          yield* thread.projection.flushOrphanFrames;
          const { message, images } = turnMessageParts(turnInput.message);
          yield* thread.client
            .client!.request("prompt", {
              message,
              streamingBehavior: "followUp",
              ...(images === undefined ? {} : { images }),
            })
            .pipe(
              // Ack failure never leaves the turn dangling: fail the terminal instead (#8 contract).
              Effect.catchCause((cause) =>
                thread.projection.finalizeTurn("failed", {
                  class: "transport_error",
                  message: `omp prompt request failed: ${Cause.pretty(cause)}`,
                  code: null,
                  retryable: null,
                }),
              ),
            );
        }),
        steerTurn: Effect.fn("OmpAdapter.steerTurn")(function* (steerInput) {
          const thread = threads.get(steerInput.providerThread.id);
          const client = thread === undefined ? undefined : thread.client.client;
          if (client === undefined || client === null || thread!.projection.state.active === null) {
            return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
              driver: OMP_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
              providerTurnId: steerInput.providerTurnId,
              cause: new Error("no active omp turn to steer"),
            });
          }
          const { message, images } = turnMessageParts(steerInput.message);
          yield* client
            .request("steer", {
              message,
              ...(images === undefined ? {} : { images }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: OMP_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            );
        }),
        interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(function* (interruptInput) {
          const thread = threads.get(interruptInput.providerThread.id);
          const client = thread === undefined ? undefined : thread.client.client;
          if (client === undefined || client === null || thread!.projection.state.active === null) {
            return;
          }
          yield* client.request("abort").pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: OMP_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          );
          // omp confirms the stop with prompt_result(status:"aborted"), which the projection
          // finalizes as turn interrupted; nothing else to do here.
        }),
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: Effect.fn("OmpAdapter.readThreadSnapshot")(function* (snapshotInput) {
          const thread = threads.get(snapshotInput.providerThread.id);
          if (thread === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: OMP_PROVIDER,
              providerThreadId: snapshotInput.providerThread.id,
              cause: new Error("omp thread not registered in this session"),
            });
          }
          // The projection state mirrors the T3 event store; no RPC is issued.
          return {
            providerThread: thread.projection.state.providerThread,
            providerTurns: thread.projection.state.turns,
            messages: thread.projection.state.messages,
            runtimeRequests: [],
          };
        }),
        rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(function* (rollbackInput) {
          const thread = threads.get(rollbackInput.providerThread.id);
          if (thread === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: OMP_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              cause: new Error("omp thread not registered in this session"),
            });
          }
          thread.projection.state.turns = [];
          thread.projection.state.messages = [];
          return {
            providerThread: thread.projection.state.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          };
        }),
        forkThread: (forkInput) =>
          registerThread({
            threadId: forkInput.targetThreadId,
            modelSelection: forkInput.modelSelection ?? sessionInput.modelSelection,
            runtimePolicy: forkInput.runtimePolicy ?? sessionInput.runtimePolicy,
          }),
      };

      yield* Effect.addFinalizer(
        Effect.fn("OmpAdapter.sessionFinalizer")(function* () {
          for (const thread of threads.values()) {
            // Stop reclaim timers first: teardown owns the drain from here (spec §5.6).
            yield* cancelIdleReclaim(thread);
            // Close stdin and drain stdout to EOF (notes §7); ignore drain failures so one
            // crashed child cannot wedge the session teardown. Drain must fully finish before
            // the child scope closes (#15 deadlock).
            yield* disposeClient(thread).pipe(Effect.ignore);
          }
          yield* Queue.end(events);
        }),
      );

      yield* emit({
        type: "provider_session.updated",
        driver: OMP_PROVIDER,
        providerSession: sessionEntity,
      });

      return runtime;
    }),
  });
});
