// omp adapter lifeline tests (ticket #15 / spec §5.4/5.5): a fake omp JSONL child drives each
// event sequence; assertions target the SessionRuntime public seam (openSession → ensureThread →
// startTurn → events stream) and the §5.5 contract hard constraints.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, live } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  ChatAttachment,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import {
  ChatAttachmentId,
  MessageId,
  ModelSelection,
  NodeId,
  ProviderSessionId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Logger from "effect/Logger";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeOmpAdapterV2, OMP_IDLE_RECLAIM_TIMEOUT_MS } from "./adapter.ts";
import { OMP_PROVIDER } from "./kind.ts";
import { writeFakeOmp, type FakeOmpProgram, type FakeOmpTimedFrame } from "../testing.ts";

const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeMessageId = Schema.decodeSync(MessageId);
const decodeRunId = Schema.decodeSync(RunId);
const decodeRunAttemptId = Schema.decodeSync(RunAttemptId);
const decodeNodeId = Schema.decodeSync(NodeId);
const decodeProviderSessionId = Schema.decodeSync(ProviderSessionId);
const decodeProviderInstanceId = Schema.decodeSync(ProviderInstanceId);
const decodeModelSelection = Schema.decodeSync(ModelSelection);

// NodeServices plus a shared TestProviderHost: attachment tests (#22) resolve ids against the
// same attachmentsDir the adapter's prompt builder sees. openHarness passes the ambient host
// through (optionally overriding resolveAttachmentPath) so test-written pixels are visible.
const NodeTestLayer = Layer.mergeAll(
  NodeServices.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const makeIds = (suffix: string) => {
  const instanceId = decodeProviderInstanceId("omp-test-instance");
  return {
    instanceId,
    threadId: decodeThreadId(`app-thread-${suffix}`),
    providerSessionId: decodeProviderSessionId(`provider-session-${suffix}`),
    runId: decodeRunId(`run-${suffix}`),
    attemptId: decodeRunAttemptId(`attempt-${suffix}`),
    rootNodeId: decodeNodeId(`node-${suffix}`),
    messageId: decodeMessageId(`msg-${suffix}`),
    modelSelection: decodeModelSelection({
      instanceId: instanceId,
      model: "zai/glm-5.3",
    }),
  };
};

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/tmp",
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

const readRequestLog = Effect.fn("adapterTest.readRequestLog")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  return contents
    .split("\n")
    .filter((line: string) => line.trim() !== "")
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
});

interface Harness {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
}

const turnMessage = (
  text: string,
  attachments: ReadonlyArray<ChatAttachment> = [],
): ProviderAdapter.ProviderAdapterV2TurnMessage => ({
  messageId: decodeMessageId(`msg-${Math.abs(text.length * 31)}`),
  text,
  attachments,
  createdBy: "user",
  creationSource: "web",
});

const appThreadFor = (threadId: ThreadId) =>
  ({
    id: threadId,
    title: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  }) as unknown as Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]
  >[0]["appThread"];

/**
 * Advanceable manual Clock (#18): the adapter's idle-reclaim timer sleeps on this clock and
 * only fires when the test calls advance(), so the 5-minute reclaim runs with zero real wait.
 */
const makeManualIdleClock = (): { clock: Clock.Clock; advance: (ms: number) => void } => {
  let nowMs = 0;
  let waiters: Array<{ atMs: number; resume: () => void }> = [];
  const nanos = () => BigInt(nowMs) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanosUnsafe: () => nanos(),
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => nanos(),
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        waiters.push({
          atMs: nowMs + Duration.toMillis(duration),
          resume: () => resume(Effect.void),
        });
      }),
  };
  return {
    clock,
    advance: (ms: number) => {
      nowMs += ms;
      const due = waiters.filter((waiter) => waiter.atMs <= nowMs);
      waiters = waiters.filter((waiter) => waiter.atMs > nowMs);
      for (const waiter of due) waiter.resume();
    },
  };
};

/** One full scripted turn ending in a completed terminal (multi-turn driving, #18). */
const completedTurnEvents = (delta: string): ReadonlyArray<FakeOmpTimedFrame> => [
  {
    delayMs: 10,
    frame: {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    },
  },
  {
    delayMs: 10,
    frame: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
    },
  },
  {
    delayMs: 10,
    frame: { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } },
  },
  { delayMs: 10, frame: { type: "agent_end", isTerminal: true } },
  { delayMs: 10, frame: { type: "prompt_result", agentInvoked: true, status: "completed" } },
];

/** Starts the nth turn on an already-registered provider thread (ordinals aligned to n). */
const driveTurn = Effect.fn("adapterTest.driveTurn")(function* (
  harness: Harness,
  ids: ReturnType<typeof makeIds>,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
) {
  const suffix = `${ids.threadId}-t${ordinal}`;
  yield* harness.runtime.startTurn({
    appThread: appThreadFor(ids.threadId),
    threadId: ids.threadId,
    runId: decodeRunId(`run-${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: decodeRunAttemptId(`attempt-${suffix}`),
    rootNodeId: ids.rootNodeId,
    providerThread,
    message: turnMessage(`prompt ${ordinal}`),
    modelSelection: ids.modelSelection,
    runtimePolicy,
  });
});

/**
 * Bounded real-time poll for a file the fake omp child writes on real time (drain marker);
 * the child's stdin-end handler is the only place the marker can appear.
 */
const waitForFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the fake omp child writes the marker on real time; there is no in-runtime event to await.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (yield* fs.exists(path)) return;
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the fake omp child writes the marker on real time; the poll bounds scheduling slack, not the reclaim timeout.
      yield* Effect.sleep(10);
    }
    throw new Error(`expected file never appeared: ${path}`);
  });

/** Opens a session, starts eagerly collecting events, and returns the runtime harness. */
const openHarness = Effect.fn("adapterTest.openHarness")(function* (
  ids: ReturnType<typeof makeIds>,
  command: string,
  options: {
    readonly idleTimeoutMs?: number | undefined;
    readonly clock?: Clock.Clock | undefined;
    /** Overrides the ambient host's attachment resolution (e.g. simulate an unresolvable id). */
    readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | null;
  } = {},
) {
  const scope = yield* Effect.scope;
  const host = yield* ProviderHost.ProviderHost;
  const effectiveHost =
    options.resolveAttachmentPath === undefined
      ? host
      : { ...host, resolveAttachmentPath: options.resolveAttachmentPath };
  const adapter = yield* makeOmpAdapterV2({
    instanceId: ids.instanceId,
    command,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  }).pipe(Effect.provideService(ProviderHost.ProviderHost, effectiveHost));
  const runtime = yield* adapter.openSession({
    threadId: ids.threadId,
    providerSessionId: ids.providerSessionId,
    modelSelection: ids.modelSelection,
    runtimePolicy,
  });
  const collected: ProviderAdapter.ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
    Effect.forkIn(scope),
  );
  const harness: Harness = { runtime, events: collected };
  return harness;
});

const eventsOf = <T extends ProviderAdapter.ProviderAdapterV2Event["type"]>(
  harness: Harness,
  type: T,
): ReadonlyArray<Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>> =>
  harness.events.filter(
    (event): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }> =>
      event.type === type,
  );

const waitFor = <T extends ProviderAdapter.ProviderAdapterV2Event["type"]>(
  harness: Harness,
  type: T,
  predicate?: (event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>) => boolean,
) =>
  Effect.gen(function* () {
    // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the fake omp child delivers its milestone frames on real time; there is no in-runtime event to await.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const match = harness.events.find(
        (event): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }> =>
          event.type === type && (predicate === undefined || predicate(event as never)),
      );
      if (match !== undefined) return match;
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the fake omp child delivers its frames on real time; the events collector is a passive drain, not a scheduler wait.
      yield* Effect.sleep(10);
    }
    throw new Error(`expected ${type} event never arrived`);
  });

const messageUpdate = (delayMs: number, event: Record<string, unknown>) => ({
  delayMs,
  frame: { type: "message_update", assistantMessageEvent: event },
});

/** omp `select` approval dialog (notes rpc-protocol §5); labels pass through per spec §6. */
const approvalFrame = (
  id: string,
  toolName: string,
  options: ReadonlyArray<string>,
): Record<string, unknown> => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: toolName,
  options: [...options],
});

/** Polls a JSONL log the fake omp children append to (no in-runtime event signals it). */
const pollLogLines = Effect.fn("adapterTest.pollLogLines")(function* (
  path: string,
  expectedCount: number,
) {
  const fs = yield* FileSystem.FileSystem;
  // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the fake omp child writes the log on real process spawn; there is no in-runtime event to await.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const contents = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const lines = contents
      .split("\n")
      .filter((line: string) => line.trim() !== "")
      .map((line: string) => JSON.parse(line) as ReadonlyArray<string>);
    if (lines.length >= expectedCount) return lines;
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- respawn is a real child-process start; no runtime signal exists.
    yield* Effect.sleep(10);
  }
  throw new Error(`expected ${expectedCount} log lines in ${path}, never arrived`);
});

/** Waits until the request log carries an entry matching the predicate (respawn is async). */
const pollRequestLog = Effect.fn("adapterTest.pollRequestLog")(function* (
  path: string,
  predicate: (request: Record<string, unknown>) => boolean,
) {
  // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the respawned child logs its requests on real IPC; no in-runtime event signals the write.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const requests = yield* readRequestLog(path);
    const matches = requests.filter(predicate);
    if (matches.length > 0) return matches;
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the respawned child needs real time to reach switch_session after boot.
    yield* Effect.sleep(10);
  }
  throw new Error(`expected a matching request in ${path}, never arrived`);
});

/** Spawns the fake omp, opens a session, registers a thread, and starts a turn. */
const startDrivenTurn = Effect.fn("adapterTest.startDrivenTurn")(function* (
  program: FakeOmpProgram,
  suffix: string,
  options: {
    readonly message?: string;
    readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: `omp-adapter-${suffix}-` });
  const requestLog = `${directory}/requests.jsonl`;
  const command = writeFakeOmp({
    directory,
    program,
    env: {
      FAKE_OMP_REQUEST_LOG: requestLog,
      ...options.env,
    },
  });
  void command;
  const ids = makeIds(suffix);
  const harness = yield* openHarness(ids, command);
  const turnPolicy = options.runtimePolicy ?? runtimePolicy;
  const providerThread = yield* harness.runtime.ensureThread({
    threadId: ids.threadId,
    modelSelection: ids.modelSelection,
    runtimePolicy: turnPolicy,
  });
  yield* harness.runtime.startTurn({
    appThread: appThreadFor(ids.threadId),
    threadId: ids.threadId,
    runId: ids.runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: ids.attemptId,
    rootNodeId: ids.rootNodeId,
    providerThread,
    message: turnMessage(options.message ?? "hello omp"),
    modelSelection: ids.modelSelection,
    runtimePolicy: turnPolicy,
  });
  return {
    harness,
    ids,
    directory,
    requestLog,
    providerThread,
    turnId: IdAllocator.derive.providerTurn({
      driver: OMP_PROVIDER,
      nativeTurnId: `${providerThread.id}:t1:r1`,
    }),
  };
});

describe("omp adapter session runtime", () => {
  live("projects a completed streaming turn (D2) with paired message events", () =>
    Effect.gen(function* () {
      const sessionFile = "/tmp/omp-adapter-fake/sessions/d2.jsonl";
      const { harness, ids, requestLog } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { cancelled: false, resumed: false, sessionId: "s-1", sessionFile },
            },
          },
          events: [
            messageUpdate(20, { type: "text_start", contentIndex: 0 }),
            messageUpdate(20, { type: "text_delta", delta: "Hello", contentIndex: 0 }),
            messageUpdate(20, { type: "text_delta", delta: " world", contentIndex: 0 }),
            messageUpdate(20, { type: "text_end", contentIndex: 0 }),
            { delayMs: 20, frame: { type: "agent_start" } },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
            { delayMs: 20, frame: { type: "session_settled" } },
          ],
        },
        "d2",
      );
      yield* waitFor(
        harness,
        "provider_session.updated",
        (event) => event.providerSession.status === "ready",
      );
      expect(eventsOf(harness, "turn.terminal")).toHaveLength(1);
      const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
      const assistantItems = items.filter((item) => item.type === "assistant_message");
      // Streaming pairs: one running update per delta + one final streaming:false update.
      expect(assistantItems).toHaveLength(3);
      expect(
        assistantItems.map((item) => (item.type === "assistant_message" ? item.streaming : null)),
      ).toEqual([true, true, false]);
      const finalItem = assistantItems.at(-1);
      expect(finalItem?.type === "assistant_message" ? finalItem.text : null).toBe("Hello world");
      const messages = eventsOf(harness, "message.updated").map((event) => event.message);
      // Every streaming turn_item has a paired message.updated; the final pair too.
      expect(messages).toHaveLength(3);
      expect(messages.at(-1)?.streaming).toBe(false);
      const messageId = finalItem?.type === "assistant_message" ? finalItem.messageId : undefined;
      expect(messages.every((message) => message.id === messageId)).toBe(true);
      // Contract: runAttemptId bound to the turn input attemptId, no "starting" state.
      const turns = eventsOf(harness, "provider_turn.updated").map((event) => event.providerTurn);
      expect(turns).toHaveLength(2);
      expect(turns[0]?.runAttemptId).toBe(ids.attemptId);
      expect(turns[0]?.status).toBe("running");
      expect(turns[1]?.runAttemptId).toBe(ids.attemptId);
      expect(turns[1]?.status).toBe("completed");
      // Contract: terminal success carries { status, failure: null, runOrdinal, threadDisposition }.
      const terminal = eventsOf(harness, "turn.terminal")[0];
      if (terminal === undefined) throw new Error("no terminal event captured");
      expect(terminal.status).toBe("completed");
      expect(terminal.failure).toBeNull();
      expect(terminal.runOrdinal).toBe(1);
      expect(terminal.threadDisposition).toBe("reusable");
      expect(terminal.providerTurnId).toBe(turns[0]?.id);
      // Lazy spawn stored the omp session under the provider thread's native metadata.
      const threadEvents = eventsOf(harness, "provider_thread.updated").map(
        (event) => event.providerThread,
      );
      expect(threadEvents.at(-1)?.nativeThreadRef?.nativeId).toBe(sessionFile);
      expect(threadEvents.at(-1)?.status).toBe("idle");
      // Contract: the adapter never builds the user message or the root node.
      const nodes = eventsOf(harness, "node.updated").map((event) => event.node);
      expect(nodes.every((node) => node.kind !== "root_turn")).toBe(true);
      expect(messages.every((message) => message.role === "assistant")).toBe(true);
      const requests = yield* readRequestLog(requestLog);
      const openSessionRequest = requests.find((request) => request["type"] === "open_session");
      // open_session carries the t3code-owned session dir: first spawn lets omp create it.
      expect(openSessionRequest).toEqual({
        id: expect.any(String),
        type: "open_session",
        sessionDir: expect.stringContaining("/.t3code/omp-sessions"),
      });
      const promptRequest = requests.find((request) => request["type"] === "prompt");
      expect(promptRequest?.["message"]).toBe("hello omp");
      expect(promptRequest?.["streamingBehavior"]).toBe("followUp");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("spawns lazily: no omp process before the first prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-lazy-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {},
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("lazy");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command);
        yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        expect(yield* readRequestLog(requestLog)).toHaveLength(0);
        expect(eventsOf(harness, "provider_thread.updated")).toHaveLength(1);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("recovers with an explicit switch_session path, never continue-latest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-resume-" });
      const sessionFile = `${directory}/sessions/multi-thread-a.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      void writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: { data: { sessionId: "s-a", sessionFile } },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "ok", contentIndex: 0 }),
            messageUpdate(20, { type: "text_end", contentIndex: 0 }),
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("resume");
      const command = `${directory}/omp`;
      yield* Effect.gen(function* () {
        const first = yield* openHarness(ids, command);
        const providerThread = yield* first.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* first.runtime.startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage("first"),
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* waitFor(first, "turn.terminal");
        const storedThread = eventsOf(first, "provider_thread.updated").at(-1)?.providerThread;
        expect(storedThread?.nativeThreadRef?.nativeId).toBe(sessionFile);
        // Fresh session runtime (as after a process teardown): resume must switch explicitly.
        const adapter = yield* makeOmpAdapterV2({ instanceId: ids.instanceId, command });
        const runtime2 = yield* adapter.openSession({
          threadId: ids.threadId,
          providerSessionId: ids.providerSessionId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* runtime2.resumeThread({
          providerThread: storedThread as OrchestrationV2ProviderThread,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        const requests = yield* readRequestLog(requestLog);
        const switches = requests.filter((request) => request["type"] === "switch_session");
        expect(switches).toHaveLength(1);
        expect(switches[0]?.["sessionPath"]).toBe(sessionFile);
        // First spawn legitimately used open_session; recovery afterwards never does.
        expect(requests.filter((request) => request["type"] === "open_session")).toHaveLength(1);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("maps abort to an interrupted terminal", () =>
    Effect.gen(function* () {
      const { harness, requestLog, providerThread, turnId } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-abort", sessionFile: "/tmp/fake-abort.jsonl" },
            },
            abort: { data: { stopped: true } },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "partial", contentIndex: 0 }),
            {
              afterRequestType: "abort",
              frame: { type: "prompt_result", agentInvoked: true, status: "aborted" },
            },
          ],
        },
        "abort",
      );
      yield* harness.runtime.interruptTurn({
        providerThread,
        providerTurnId: turnId,
      });
      const terminal = yield* waitFor(
        harness,
        "turn.terminal",
        (event) => event.status === "interrupted",
      );
      expect(terminal.status).toBe("interrupted");
      expect(terminal.failure).toBeNull();
      const turns = eventsOf(harness, "provider_turn.updated").map((event) => event.providerTurn);
      expect(turns.at(-1)?.status).toBe("interrupted");
      const requests = yield* readRequestLog(requestLog);
      expect(requests.some((request) => request["type"] === "abort")).toBe(true);
      // The interrupted stream item still closed with streaming:false.
      const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
      const last = items.at(-1);
      expect(last?.type === "assistant_message" ? last.streaming : null).toBe(false);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("maps prompt_result error to the failed terminal branch", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-error", sessionFile: "/tmp/fake-error.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: {
                type: "prompt_result",
                agentInvoked: true,
                status: "error",
                error: { message: "upstream 503", provider: "zai", retryable: false },
              },
            },
          ],
        },
        "error",
      );
      const terminal = yield* waitFor(harness, "turn.terminal");
      if (terminal.status !== "failed")
        throw new Error(`expected failed terminal, got ${terminal.status}`);
      expect(terminal.failure.message).toBe("upstream 503");
      expect(terminal.failure.code).toBeNull();
      expect(terminal.failure.retryable).toBe(false);
      expect(terminal.failureItemOrdinal).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("streams reasoning deltas as reasoning items without message pairs", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-think", sessionFile: "/tmp/fake-think.jsonl" },
            },
          },
          events: [
            messageUpdate(20, { type: "thinking_start", contentIndex: 0 }),
            messageUpdate(20, { type: "thinking_delta", delta: "ponder", contentIndex: 0 }),
            messageUpdate(20, { type: "thinking_end", contentIndex: 0 }),
            messageUpdate(20, { type: "text_start", contentIndex: 1 }),
            messageUpdate(20, { type: "text_delta", delta: "answer", contentIndex: 1 }),
            messageUpdate(20, { type: "text_end", contentIndex: 1 }),
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "thinking",
      );
      yield* waitFor(harness, "turn.terminal");
      const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
      const reasoning = items.filter((item) => item.type === "reasoning");
      expect(reasoning.map((item) => (item.type === "reasoning" ? item.streaming : null))).toEqual([
        true,
        false,
      ]);
      const lastReasoning = reasoning.at(-1);
      expect(lastReasoning?.type === "reasoning" ? lastReasoning.text : null).toBe("ponder");
      // Only the assistant_message pairs reach message.updated.
      expect(eventsOf(harness, "message.updated")).toHaveLength(2);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("projects tool_execution start/end into tool items", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-tool", sessionFile: "/tmp/fake-tool.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: {
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "bash",
                args: { command: "ls" },
              },
            },
            {
              delayMs: 20,
              frame: {
                type: "tool_execution_end",
                toolCallId: "tool-1",
                result: { output: "file.txt" },
              },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "tool",
      );
      yield* waitFor(harness, "turn.terminal");
      const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
      const toolItems = items.filter((item) => item.type === "dynamic_tool");
      expect(toolItems).toHaveLength(2);
      expect(toolItems[0]?.status).toBe("running");
      expect(toolItems[1]?.status).toBe("completed");
      const finished = toolItems[1];
      expect(finished?.type === "dynamic_tool" ? finished.toolName : null).toBe("bash");
      const nodes = eventsOf(harness, "node.updated").map((event) => event.node);
      expect(nodes.filter((node) => node.kind === "tool_call")).toHaveLength(2);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("holds the terminal behind a maintenance agent_end (isTerminal:false)", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-term", sessionFile: "/tmp/fake-term.jsonl" },
            },
          },
          events: [
            { delayMs: 20, frame: { type: "agent_end", isTerminal: false } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
          ],
        },
        "terminal",
      );
      const terminal = yield* waitFor(harness, "turn.terminal");
      expect(terminal.status).toBe("completed");
      expect(eventsOf(harness, "turn.terminal")).toHaveLength(1);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("projects queue_update into background work pending state", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-queue", sessionFile: "/tmp/fake-queue.jsonl" },
            },
          },
          events: [
            { delayMs: 20, frame: { type: "queue_update", steering: ["m1"], followUp: [] } },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "queue",
      );
      yield* waitFor(harness, "background_work.updated");
      const background = eventsOf(harness, "background_work.updated");
      expect(background).toHaveLength(1);
      expect(background[0]?.pending).toBe(true);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("reports a crashed process instead of failing silently", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-crash", sessionFile: "/tmp/fake-crash.jsonl" },
            },
          },
          events: [messageUpdate(20, { type: "text_delta", delta: "partial", contentIndex: 0 })],
          crash: { delayMs: 40, exitCode: 3 },
        },
        "crash",
      );
      const terminal = yield* waitFor(harness, "turn.terminal");
      expect(terminal.status).toBe("interrupted");
      yield* waitFor(
        harness,
        "provider_thread.updated",
        (event) => event.providerThread.status === "error",
      );
      expect(eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread.status).toBe(
        "error",
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("tolerates frames reserved for later tickets", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-tol", sessionFile: "/tmp/fake-tol.jsonl" },
            },
          },
          events: [
            { delayMs: 20, frame: { type: "available_commands_update", commands: [] } },
            { delayMs: 20, frame: { type: "extension_ui_request", id: "u1", method: "setWidget" } },
            { delayMs: 20, frame: { type: "model_changed", model: "zai/glm-5.3" } },
            {
              delayMs: 20,
              frame: { type: "subagent_lifecycle", subagentId: "sub-1", status: "running" },
            },
            { delayMs: 20, frame: { type: "auto_compaction_start" } },
            { delayMs: 20, frame: { type: "notice", message: "hi" } },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "tolerate",
      );
      const terminal = yield* waitFor(harness, "turn.terminal");
      expect(terminal.status).toBe("completed");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("carries turn tokenUsage from usage frames and refreshes the meter at terminal (D9)", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-usage", sessionFile: "/tmp/fake-usage.jsonl" },
            },
            get_state: {
              data: {
                isSettled: true,
                contextUsage: { tokens: 140, contextWindow: 2048, percent: 6.8 },
              },
            },
          },
          events: [
            messageUpdate(20, { type: "text_start", contentIndex: 0 }),
            messageUpdate(20, { type: "text_delta", delta: "answer", contentIndex: 0 }),
            messageUpdate(20, { type: "text_end", contentIndex: 0 }),
            {
              delayMs: 20,
              frame: {
                type: "message_end",
                message: {
                  role: "assistant",
                  usage: {
                    input: 100,
                    output: 20,
                    cacheRead: 10,
                    cacheWrite: 0,
                    totalTokens: 130,
                    contextTokens: 150,
                    reasoningTokens: 8,
                  },
                },
              },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "usage",
      );
      yield* waitFor(harness, "turn.terminal");
      const turns = eventsOf(harness, "provider_turn.updated").map((event) => event.providerTurn);
      // Live usage from message_end: omp Usage → turn tokenUsage (contextTokens drives usedTokens).
      const liveUsage = turns[1]?.tokenUsage;
      expect(liveUsage).toEqual({
        usedTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 8,
        updatedAt: expect.any(String),
      });
      // Terminal get_state reading wins on usedTokens/maxTokens and lands on the final turn.
      expect(turns.at(-1)?.status).toBe("completed");
      expect(turns.at(-1)?.tokenUsage).toEqual({
        usedTokens: 140,
        maxTokens: 2048,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 8,
        updatedAt: expect.any(String),
      });
      // Meter: the thread contextUsage snapshot mirrors the get_state reading with the
      // truth-table bit for native auto-compaction set (spec §7).
      const thread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
      expect(thread?.contextUsage).toEqual({
        usedTokens: 140,
        maxTokens: 2048,
        compactsAutomatically: true,
      });
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live(
    "projects compaction frames into hint lines and meter updates without rewriting the transcript (D9)",
    () =>
      Effect.gen(function* () {
        const { harness } = yield* startDrivenTurn(
          {
            responses: {
              open_session: {
                data: { sessionId: "s-compact", sessionFile: "/tmp/fake-compact.jsonl" },
              },
              get_state: {
                data: {
                  isSettled: true,
                  contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 },
                },
              },
            },
            events: [
              {
                delayMs: 20,
                frame: {
                  type: "available_commands_update",
                  commands: [
                    {
                      name: "compact",
                      description: "Summarize the conversation so far",
                      input: { hint: "Optional focus" },
                    },
                    { name: "plan", description: "Toggle plan mode" },
                  ],
                },
              },
              messageUpdate(20, { type: "text_start", contentIndex: 0 }),
              messageUpdate(20, { type: "text_delta", delta: "pre-compaction", contentIndex: 0 }),
              messageUpdate(20, { type: "text_end", contentIndex: 0 }),
              {
                delayMs: 20,
                frame: {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    usage: { input: 90, output: 15, cacheRead: 5, cacheWrite: 0, totalTokens: 110 },
                  },
                },
              },
              // Auto compaction: full lifecycle with a committed result.
              {
                delayMs: 20,
                frame: {
                  type: "auto_compaction_start",
                  reason: "threshold",
                  action: "context-full",
                },
              },
              {
                delayMs: 20,
                frame: {
                  type: "auto_compaction_end",
                  action: "context-full",
                  result: { summary: "Old context summarized", tokensBefore: 900 },
                  aborted: false,
                  willRetry: false,
                },
              },
              // Manual compaction: the /compact RPC path, same projection.
              { delayMs: 20, frame: { type: "manual_compaction_start", mode: "accurate" } },
              {
                delayMs: 20,
                frame: {
                  type: "manual_compaction_end",
                  result: { summary: "Manual summary", tokensBefore: 300 },
                  aborted: false,
                },
              },
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
          "compact",
        );
        yield* waitFor(harness, "turn.terminal");
        const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
        const compactions = items.filter((item) => item.type === "compaction");
        // Hint lines: running → completed per compaction, contract shape with omp details.
        expect(
          compactions.map((item) => (item.type === "compaction" ? item.status : null)),
        ).toEqual(["running", "completed", "running", "completed"]);
        expect(compactions[0]?.title).toBe("Compacting context...");
        const firstDone = compactions[1];
        expect(firstDone?.type === "compaction" ? firstDone.title : null).toBe("Context compacted");
        expect(firstDone?.type === "compaction" ? firstDone.summary : null).toBe(
          "Old context summarized",
        );
        expect(firstDone?.type === "compaction" ? firstDone.beforeTokenCount : null).toBe(900);
        expect(firstDone?.type === "compaction" ? firstDone.driver : null).toBe(OMP_PROVIDER);
        const secondDone = compactions[3];
        expect(secondDone?.type === "compaction" ? secondDone.summary : null).toBe(
          "Manual summary",
        );
        expect(secondDone?.type === "compaction" ? secondDone.beforeTokenCount : null).toBe(300);
        // Hint lines own system nodes that never count for the run.
        const systemNodes = eventsOf(harness, "node.updated").filter(
          (event) => event.node.kind === "system",
        );
        expect(systemNodes.map((event) => event.node.status)).toEqual([
          "running",
          "completed",
          "running",
          "completed",
        ]);
        expect(systemNodes.every((event) => event.node.countsForRun === false)).toBe(true);
        // Transcript invariant: after the first compaction hint line no assistant message is
        // re-emitted, and the final message history is byte-identical (append-only store).
        const firstCompactionIndex = harness.events.findIndex(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        );
        expect(
          harness.events
            .slice(firstCompactionIndex)
            .filter(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
            ),
        ).toHaveLength(0);
        const finalMessageTexts = (events: Harness["events"]) =>
          events.flatMap((event) =>
            event.type === "message.updated" && !event.message.streaming
              ? [event.message.text]
              : [],
          );
        expect(finalMessageTexts(harness.events)).toEqual(
          finalMessageTexts(harness.events.slice(0, firstCompactionIndex)),
        );
        expect(finalMessageTexts(harness.events)).toEqual(["pre-compaction"]);
        // Meter: refreshed from get_state after compaction and again at terminal; the snapshot
        // carries the compactsAutomatically truth-table bit.
        const thread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
        expect(thread?.contextUsage).toEqual({
          usedTokens: 120,
          maxTokens: 1000,
          compactsAutomatically: true,
        });
        // Terminal tokenUsage merges the live usage with the fresh get_state reading.
        const turns = eventsOf(harness, "provider_turn.updated").map((event) => event.providerTurn);
        expect(turns.at(-1)?.tokenUsage).toEqual({
          usedTokens: 120,
          maxTokens: 1000,
          inputTokens: 90,
          cachedInputTokens: 5,
          outputTokens: 15,
          updatedAt: expect.any(String),
        });
        // §7: the declared slash-command directory carries the compact entry (passthrough, #19).
        const directory = eventsOf(harness, "provider_slash_commands.updated").at(-1);
        expect(directory?.slashCommands).toContainEqual({
          name: "compact",
          description: "Summarize the conversation so far",
          input: { hint: "Optional focus" },
        });
      }).pipe(Effect.provide(NodeTestLayer)),
  );

  live(
    "projects aborted, skipped, and failed compaction outcomes without inventing meter readings",
    () =>
      Effect.gen(function* () {
        const { harness } = yield* startDrivenTurn(
          {
            responses: {
              open_session: {
                data: {
                  sessionId: "s-compact-outcome",
                  sessionFile: "/tmp/fake-compact-outcome.jsonl",
                },
              },
              // No contextUsage in get_state: no meter reading may be fabricated.
              get_state: { data: { isSettled: true } },
            },
            events: [
              { delayMs: 20, frame: { type: "manual_compaction_start", mode: "fast" } },
              { delayMs: 20, frame: { type: "manual_compaction_end", aborted: true } },
              { delayMs: 20, frame: { type: "manual_compaction_start" } },
              {
                delayMs: 20,
                frame: {
                  type: "manual_compaction_end",
                  aborted: false,
                  skipped: true,
                  errorMessage: "Nothing to compact yet",
                },
              },
              {
                delayMs: 20,
                frame: { type: "auto_compaction_start", reason: "overflow", action: "remote" },
              },
              {
                delayMs: 20,
                frame: {
                  type: "auto_compaction_end",
                  action: "remote",
                  result: undefined,
                  aborted: false,
                  willRetry: true,
                  errorMessage: "remote compaction unavailable",
                },
              },
              // Left open on purpose: the turn terminal must close it as cancelled.
              {
                delayMs: 20,
                frame: {
                  type: "auto_compaction_start",
                  reason: "threshold",
                  action: "context-full",
                },
              },
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
          "compact-outcome",
        );
        yield* waitFor(harness, "turn.terminal");
        const compactions = eventsOf(harness, "turn_item.updated")
          .map((event) => event.turnItem)
          .filter((item) => item.type === "compaction");
        expect(
          compactions.map((item) => (item.type === "compaction" ? item.status : null)),
        ).toEqual([
          "running",
          "cancelled",
          "running",
          "completed",
          "running",
          "failed",
          "running",
          "cancelled",
        ]);
        expect(compactions[1]?.title).toBe("Context compaction stopped");
        expect(compactions[2]?.title).toBe("Compacting context...");
        const skipped = compactions[3];
        expect(skipped?.type === "compaction" ? skipped.summary : null).toBe(
          "Nothing to compact yet",
        );
        expect(compactions[5]?.title).toBe("Context compaction failed");
        expect(compactions[5]?.type === "compaction" ? compactions[5].summary : null).toBe(
          "remote compaction unavailable",
        );
        // No contextUsage anywhere in the frames: the meter stays null, never fabricated.
        const thread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
        expect(thread?.contextUsage ?? null).toBeNull();
        const turns = eventsOf(harness, "provider_turn.updated").map((event) => event.providerTurn);
        expect(turns.at(-1)?.tokenUsage).toBeUndefined();
      }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("projects subagent lifecycle frames into subagent.updated (running→completed)", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-sub", sessionFile: "/tmp/fake-sub.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: {
                type: "subagent_lifecycle",
                subagentId: "sub-1",
                status: "running",
                title: "researcher",
                prompt: "look into the flaky test",
                model: "zai/glm-5.3",
              },
            },
            {
              delayMs: 20,
              frame: {
                type: "subagent_lifecycle",
                subagentId: "sub-1",
                status: "completed",
                result: "the flaky test was a race",
              },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "sublife",
      );
      const terminal = yield* waitFor(harness, "turn.terminal");
      expect(terminal.status).toBe("completed");
      const updates = eventsOf(harness, "subagent.updated");
      expect(updates).toHaveLength(2);
      // One stable contract identity across the lifecycle, derived from the native id.
      expect(updates[0]?.subagent.id).toBe(updates[1]?.subagent.id);
      expect(updates[0]?.subagent.status).toBe("running");
      expect(updates[0]?.subagent.title).toBe("researcher");
      expect(updates[0]?.subagent.prompt).toBe("look into the flaky test");
      expect(updates[0]?.subagent.model).toBe("zai/glm-5.3");
      expect(updates[0]?.subagent.startedAt).not.toBeNull();
      expect(updates[0]?.subagent.completedAt).toBeNull();
      expect(updates[0]?.subagent.nativeTaskRef).toEqual({
        driver: "omp",
        nativeId: "sub-1",
        strength: "strong",
      });
      // Final value wins: completed with a result and a completion timestamp.
      expect(updates[1]?.subagent.status).toBe("completed");
      expect(updates[1]?.subagent.result).toBe("the flaky test was a race");
      expect(updates[1]?.subagent.completedAt).not.toBeNull();
      expect(updates[1]?.subagent.title).toBe("researcher");
      // Bound to the driving turn / thread context.
      expect(updates[0]?.subagent.threadId).toBeDefined();
      expect(updates[0]?.subagent.providerThreadId).toBeDefined();
      expect(updates[0]?.subagent.origin).toBe("provider_native");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("projects subagent progress frames into the progress field", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-subp", sessionFile: "/tmp/fake-subp.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: { type: "subagent_lifecycle", subagentId: "sub-p", status: "running" },
            },
            {
              delayMs: 20,
              frame: { type: "subagent_progress", subagentId: "sub-p", progress: "scanning 42%" },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "subprog",
      );
      yield* waitFor(harness, "turn.terminal");
      const updates = eventsOf(harness, "subagent.updated");
      expect(updates).toHaveLength(2);
      expect(updates[0]?.subagent.progress).toBeUndefined();
      expect(updates[1]?.subagent.progress).toBe("scanning 42%");
      // Progress never flips the status away from what lifecycle reported.
      expect(updates[1]?.subagent.status).toBe("running");
      expect(updates[1]?.subagent.completedAt).toBeNull();
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("passes subagent_event payloads through on the subagent record", () =>
    Effect.gen(function* () {
      const { harness } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-sube", sessionFile: "/tmp/fake-sube.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: { type: "subagent_lifecycle", subagentId: "sub-e", status: "running" },
            },
            {
              delayMs: 20,
              frame: {
                type: "subagent_event",
                subagentId: "sub-e",
                event: { kind: "tool_execution_start", toolName: "grep" },
              },
            },
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "subevent",
      );
      yield* waitFor(harness, "turn.terminal");
      const updates = eventsOf(harness, "subagent.updated");
      expect(updates).toHaveLength(2);
      const progress = updates[1]?.subagent.progress ?? "";
      // Transparent passthrough: the inner event is reachable verbatim on the record.
      expect(progress).toContain("tool_execution_start");
      expect(progress).toContain("grep");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("closes a subagent through cancel_subagent (stopSubagent, D12)", () =>
    Effect.gen(function* () {
      const { harness, requestLog, providerThread } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-cancel", sessionFile: "/tmp/fake-cancel.jsonl" },
            },
            cancel_subagent: { data: { cancelled: true } },
          },
          events: [
            {
              delayMs: 20,
              frame: { type: "subagent_lifecycle", subagentId: "sub-x", status: "running" },
            },
            { delayMs: 40, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "subcancel",
      );
      yield* waitFor(harness, "subagent.updated");
      const stopSubagent = harness.runtime.stopSubagent;
      if (stopSubagent === undefined) throw new Error("omp runtime must expose stopSubagent");
      // Idempotent close: omp answers cancelled:false for a dead id without erroring.
      yield* stopSubagent({ providerThread, nativeTaskId: "sub-x" });
      yield* stopSubagent({ providerThread, nativeTaskId: "sub-gone" });
      yield* waitFor(harness, "turn.terminal");
      const requests = yield* readRequestLog(requestLog);
      const cancels = requests.filter((request) => request["type"] === "cancel_subagent");
      expect(cancels.map((request) => request["subagentId"])).toEqual(["sub-x", "sub-gone"]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("exposes the capability truth table and one shared capabilities object", () =>
    Effect.gen(function* () {
      const ids = makeIds("cap");
      const adapter = yield* makeOmpAdapterV2({ instanceId: ids.instanceId });
      const capabilities = yield* adapter.getCapabilities();
      // Truth table: every group position is filled (#8 hard constraint).
      for (const group of [
        "sessions",
        "threads",
        "turns",
        "streaming",
        "tools",
        "approvals",
        "planning",
        "subagents",
        "context",
        "checkpointing",
        "identity",
      ] as const) {
        expect(Object.keys(capabilities[group]).length).toBeGreaterThan(0);
      }
      // Spec §7 truth table final values (#23): true = supports/emits/closable; everything
      // else (ids, fork, wait, approvals origin) stays false.
      expect(capabilities.subagents).toEqual({
        supportsSubagents: true,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: true,
        canWaitForSubagents: false,
        canCloseSubagents: true,
        canForkSubagentThread: false,
      });
      expect(capabilities.approvals.approvalsCanOriginateFromSubagents).toBe(false);
      yield* Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const runtime = yield* adapter.openSession({
          threadId: ids.threadId,
          providerSessionId: ids.providerSessionId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        // provider_session.capabilities carries the exact same truth table object.
        const session: OrchestrationV2ProviderSession = runtime.providerSession;
        expect(session.capabilities).toBe(capabilities);
        void scope;
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("steers the active turn through the steer command", () =>
    Effect.gen(function* () {
      const { harness, requestLog, ids, providerThread, turnId } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-steer", sessionFile: "/tmp/fake-steer.jsonl" },
            },
            steer: { data: { queued: true } },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "working", contentIndex: 0 }),
            { afterRequestType: "steer", frame: { type: "agent_end", isTerminal: true } },
            {
              afterRequestType: "steer",
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "steer",
      );
      yield* harness.runtime.steerTurn({
        threadId: ids.threadId,
        runId: ids.runId,
        providerThread,
        providerTurnId: turnId,
        message: turnMessage("focus on the tests"),
      });
      yield* waitFor(harness, "turn.terminal");
      const requests = yield* readRequestLog(requestLog);
      const steer = requests.find((request) => request["type"] === "steer");
      expect(steer?.["message"]).toBe("focus on the tests");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("reclaims an idle process after the timeout and revives it on the next prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-idle-" });
      const sessionFile = `${directory}/sessions/idle.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      const drainMarker = `${directory}/drain-marker`;
      const exitLog = `${directory}/exit.log`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: { open_session: { data: { sessionId: "s-idle", sessionFile } } },
          eventsOnPrompt: [
            completedTurnEvents("first"),
            completedTurnEvents("second"),
            completedTurnEvents("third"),
          ],
          framesOnStdinEnd: [{ type: "session_settled" }],
          exitCodeOnStdinEnd: 0,
        },
        env: {
          FAKE_OMP_REQUEST_LOG: requestLog,
          FAKE_OMP_DRAIN_MARKER: drainMarker,
          FAKE_OMP_EXIT_LOG: exitLog,
        },
      });
      const manualClock = makeManualIdleClock();
      const ids = makeIds("idle");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command, {
          idleTimeoutMs: OMP_IDLE_RECLAIM_TIMEOUT_MS,
          clock: manualClock.clock,
        });
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* driveTurn(harness, ids, providerThread, 1);
        yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 1);
        // The settle arms the reclaim timer on the manual clock. Give the forked timer a
        // moment to register its sleep (scheduling slack, not the idle timeout), then prove
        // 1ms short of the timeout does not reclaim.
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- bounding the forked timer's scheduling slack; the reclaim timeout itself runs on the injected manual clock.
        yield* Effect.sleep(100);
        manualClock.advance(OMP_IDLE_RECLAIM_TIMEOUT_MS - 1_000);
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving non-reclamation needs a bounded observation window on real time.
        yield* Effect.sleep(150);
        expect(yield* fs.exists(drainMarker)).toBe(false);
        let requests = yield* readRequestLog(requestLog);
        expect(requests.filter((request) => request["type"] === "negotiate_protocol")).toHaveLength(
          1,
        );

        // A prompt inside the window cancels the reclaim and reuses the same process.
        yield* driveTurn(harness, ids, providerThread, 2);
        yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 2);
        requests = yield* readRequestLog(requestLog);
        expect(requests.filter((request) => request["type"] === "negotiate_protocol")).toHaveLength(
          1,
        );
        expect(requests.filter((request) => request["type"] === "switch_session")).toHaveLength(0);
        expect(yield* fs.exists(drainMarker)).toBe(false);

        // Idle past the full timeout with no prompt: stdin closes, stdout drains to EOF, exit 0.
        manualClock.advance(OMP_IDLE_RECLAIM_TIMEOUT_MS);
        yield* waitForFile(drainMarker);
        expect(yield* fs.readFileString(exitLog)).toBe("0");
        // The reclaim stays silent: the thread keeps its idle status and session reference.
        const threadEvents = eventsOf(harness, "provider_thread.updated").map(
          (event) => event.providerThread,
        );
        expect(threadEvents.at(-1)?.status).toBe("idle");
        expect(threadEvents.at(-1)?.nativeThreadRef?.nativeId).toBe(sessionFile);

        // The T3 snapshot survives the reclaim untouched.
        const snapshot = yield* harness.runtime.readThreadSnapshot({ providerThread });
        expect(snapshot.providerTurns).toHaveLength(2);
        expect(snapshot.providerThread.status).toBe("idle");

        // Revival: the next prompt respawns and switches back to the same session path.
        yield* driveTurn(harness, ids, providerThread, 3);
        yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 3);
        requests = yield* readRequestLog(requestLog);
        const switches = requests.filter((request) => request["type"] === "switch_session");
        expect(switches).toHaveLength(1);
        expect(switches[0]?.["sessionPath"]).toBe(sessionFile);
        // First spawn legitimately used open_session; only the revival respawns.
        expect(requests.filter((request) => request["type"] === "open_session")).toHaveLength(1);
        expect(requests.filter((request) => request["type"] === "negotiate_protocol")).toHaveLength(
          2,
        );
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("does not reclaim the process while a turn is active", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-active-" });
      const requestLog = `${directory}/requests.jsonl`;
      const drainMarker = `${directory}/drain-marker`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-active", sessionFile: "/tmp/fake-active.jsonl" },
            },
          },
          eventsOnPrompt: [
            [
              {
                delayMs: 10,
                frame: {
                  type: "message_update",
                  assistantMessageEvent: { type: "text_delta", delta: "ongoing", contentIndex: 0 },
                },
              },
            ],
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog, FAKE_OMP_DRAIN_MARKER: drainMarker },
      });
      const manualClock = makeManualIdleClock();
      const ids = makeIds("active");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command, {
          idleTimeoutMs: OMP_IDLE_RECLAIM_TIMEOUT_MS,
          clock: manualClock.clock,
        });
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* driveTurn(harness, ids, providerThread, 1);
        yield* waitFor(
          harness,
          "turn_item.updated",
          (event) => event.turnItem.type === "assistant_message",
        );
        // Twice the idle timeout elapses while the turn is still open: no reclaim.
        manualClock.advance(2 * OMP_IDLE_RECLAIM_TIMEOUT_MS);
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving non-reclamation needs a bounded observation window on real time.
        yield* Effect.sleep(150);
        expect(yield* fs.exists(drainMarker)).toBe(false);
        const requests = yield* readRequestLog(requestLog);
        expect(requests.filter((request) => request["type"] === "negotiate_protocol")).toHaveLength(
          1,
        );
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("recovers from a crash by respawning onto the same session on the next prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-crash2-" });
      const sessionFile = `${directory}/sessions/crashy.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      // Phase 1: the child turns partial output and then crashes mid-turn.
      const command = writeFakeOmp({
        directory,
        program: {
          responses: { open_session: { data: { sessionId: "s-crash2", sessionFile } } },
          eventsOnPrompt: [
            [
              {
                delayMs: 10,
                frame: {
                  type: "message_update",
                  assistantMessageEvent: { type: "text_delta", delta: "partial", contentIndex: 0 },
                },
              },
            ],
          ],
          crash: { delayMs: 300, exitCode: 3 },
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("crash2");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command);
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* driveTurn(harness, ids, providerThread, 1);
        // Crash mid-turn: the active turn ends interrupted and the thread disconnects.
        yield* waitFor(
          harness,
          "turn.terminal",
          (event) => event.runOrdinal === 1 && event.status === "interrupted",
        );
        yield* waitFor(
          harness,
          "provider_thread.updated",
          (event) => event.providerThread.status === "error",
        );
        const storedSession = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread
          .nativeThreadRef?.nativeId;
        expect(storedSession).toBe(sessionFile);
        // Phase 2: same fake path, healthy behavior — models the operator fixing the crash.
        writeFakeOmp({
          directory,
          program: {
            responses: { open_session: { data: { sessionId: "s-crash2", sessionFile } } },
            eventsOnPrompt: [completedTurnEvents("revived")],
          },
          env: { FAKE_OMP_REQUEST_LOG: requestLog },
        });
        // The next prompt respawns and switches explicitly back to the same session.
        yield* driveTurn(harness, ids, providerThread, 2);
        yield* waitFor(
          harness,
          "turn.terminal",
          (event) => event.runOrdinal === 2 && event.status === "completed",
        );
        const requests = yield* readRequestLog(requestLog);
        const switches = requests.filter((request) => request["type"] === "switch_session");
        expect(switches).toHaveLength(1);
        expect(switches[0]?.["sessionPath"]).toBe(sessionFile);
        expect(requests.filter((request) => request["type"] === "open_session")).toHaveLength(1);
        expect(requests.filter((request) => request["type"] === "negotiate_protocol")).toHaveLength(
          2,
        );
        const threadEvents = eventsOf(harness, "provider_thread.updated").map(
          (event) => event.providerThread,
        );
        expect(threadEvents.at(-1)?.status).toBe("idle");
        expect(threadEvents.at(-1)?.nativeThreadRef?.nativeId).toBe(sessionFile);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("wires child stderr into the server log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-stderr-" });
      const requestLog = `${directory}/requests.jsonl`;
      const stderrText = "warn: model catalog refresh failed";
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-stderr", sessionFile: "/tmp/fake-stderr.jsonl" },
            },
          },
          eventsOnPrompt: [completedTurnEvents("logged")],
          stderrOnReady: [{ delayMs: 20, text: `${stderrText}\n` }],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const loggedLines: Array<string> = [];
      const captureLogger = Logger.make(({ message }) => {
        loggedLines.push(typeof message === "string" ? message : JSON.stringify(message));
      });
      const ids = makeIds("stderr");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command);
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* driveTurn(harness, ids, providerThread, 1);
        yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 1);
        expect(
          loggedLines.some((line) => line.includes(stderrText)),
          `expected stderr in server log, got ${JSON.stringify(loggedLines)}`,
        ).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })),
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("refreshes the slash-command directory from available_commands_update (D11)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-slash-" });
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-slash", sessionFile: "/tmp/fake-slash.jsonl" },
            },
          },
          events: [
            {
              delayMs: 20,
              frame: {
                type: "available_commands_update",
                commands: [
                  { name: "plan", description: "Toggle plan mode", source: "builtin" },
                  {
                    name: "compact",
                    description: "Summarize the conversation",
                    input: { hint: "Optional instructions" },
                  },
                  { name: "review", source: "skill" },
                ],
              },
            },
            // Full replacement: review disappears, description-less entries stay valid.
            {
              delayMs: 20,
              frame: {
                type: "available_commands_update",
                commands: [
                  { name: "plan" },
                  { name: "compact", input: { hint: "Optional instructions" } },
                ],
              },
            },
            // Empty catalog is a valid full replacement, never an error (spec §5.5).
            { delayMs: 20, frame: { type: "available_commands_update", commands: [] } },
            // Malformed frame (no commands array): tolerated, no refresh, no error.
            { delayMs: 20, frame: { type: "available_commands_update" } },
          ],
        },
      });
      const ids = makeIds("slash");
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command);
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        // Lazy spawn via resume: the startup catalog must land without any turn (spec §7).
        yield* harness.runtime.resumeThread({
          providerThread,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        const refreshes = () => eventsOf(harness, "provider_slash_commands.updated");
        // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the fake omp child delivers its milestone frames on real time; there is no in-runtime event to await.
        for (let attempt = 0; attempt < 500 && refreshes().length < 3; attempt += 1) {
          // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the fake omp child delivers its frames on real time; the events collector is a passive drain, not a scheduler wait.
          yield* Effect.sleep(10);
        }
        expect(refreshes()).toHaveLength(3);
        expect(refreshes()[0]?.driver).toBe(OMP_PROVIDER);
        expect(refreshes()[0]?.providerThreadId).toBe(providerThread.id);
        // Contract shape {name, description?, input?{hint}}; omp-only fields (source) dropped.
        expect(refreshes()[0]?.slashCommands).toEqual([
          { name: "plan", description: "Toggle plan mode" },
          {
            name: "compact",
            description: "Summarize the conversation",
            input: { hint: "Optional instructions" },
          },
          { name: "review" },
        ]);
        expect(refreshes()[1]?.slashCommands).toEqual([
          { name: "plan" },
          { name: "compact", input: { hint: "Optional instructions" } },
        ]);
        expect(refreshes()[2]?.slashCommands).toEqual([]);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("passes slash-command prompts through to omp verbatim (D11)", () =>
    Effect.gen(function* () {
      const { harness, requestLog, ids, providerThread, turnId } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-plan", sessionFile: "/tmp/fake-plan.jsonl" },
            },
            steer: { data: { queued: true } },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "planning", contentIndex: 0 }),
            { afterRequestType: "steer", frame: { type: "agent_end", isTerminal: true } },
            {
              afterRequestType: "steer",
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "plan",
        { message: "/plan draft the migration plan" },
      );
      // No catalog frame was pushed: empty directory, no refresh event, no error.
      expect(eventsOf(harness, "provider_slash_commands.updated")).toHaveLength(0);
      yield* harness.runtime.steerTurn({
        threadId: ids.threadId,
        runId: ids.runId,
        providerThread,
        providerTurnId: turnId,
        message: turnMessage("/compact keep the summary"),
      });
      yield* waitFor(harness, "turn.terminal");
      const requests = yield* readRequestLog(requestLog);
      // Slash commands are prompt text: neither /plan nor /compact is intercepted or parsed.
      expect(requests.find((request) => request["type"] === "prompt")?.["message"]).toBe(
        "/plan draft the migration plan",
      );
      expect(requests.find((request) => request["type"] === "steer")?.["message"]).toBe(
        "/compact keep the summary",
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live(
    "applies the selected model with set_model before the prompt and stores it in metadata",
    () =>
      Effect.gen(function* () {
        const { harness, requestLog } = yield* startDrivenTurn(
          {
            responses: {
              open_session: {
                data: { sessionId: "s-model", sessionFile: "/tmp/fake-model.jsonl" },
              },
              set_model: { data: { id: "glm-5.3", provider: "zai" } },
            },
            events: [
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
          "model",
        );
        yield* waitFor(harness, "turn.terminal");
        const requests = yield* readRequestLog(requestLog);
        const setModel = requests.find((request) => request["type"] === "set_model");
        // The thread idle-switches onto the turn's selection with omp's exact parameter names.
        expect(setModel).toEqual({
          id: expect.any(String),
          type: "set_model",
          provider: "zai",
          modelId: "glm-5.3",
        });
        const setModelIndex = requests.indexOf(setModel!);
        const promptIndex = requests.findIndex((request) => request["type"] === "prompt");
        expect(promptIndex).toBeGreaterThan(setModelIndex);
        // The applied model lands in thread metadata so recovery can restore it.
        const storedThread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
        expect(storedThread?.nativeMetadata?.modelSelection?.model).toBe("zai/glm-5.3");
      }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("keeps the applied model across turns and only switches on a change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-switch-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-switch", sessionFile: "/tmp/fake-switch.jsonl" },
            },
          },
          eventsPerRequest: {
            prompt: [
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("switch");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const moonshotSelection = decodeModelSelection({
        instanceId: ids.instanceId,
        model: "moonshot/kimi-k2",
      });
      const startTurnWith = (selection: typeof ids.modelSelection, runOrdinal: number) =>
        harness.runtime.startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal,
          providerTurnOrdinal: runOrdinal,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage(`turn ${runOrdinal}`),
          modelSelection: selection,
          runtimePolicy,
        });
      yield* startTurnWith(ids.modelSelection, 1);
      yield* waitFor(harness, "turn.terminal");
      // Same selection again: no redundant set_model.
      yield* startTurnWith(ids.modelSelection, 2);
      yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 2);
      // A different selection switches again with the new pair.
      yield* startTurnWith(moonshotSelection, 3);
      yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 3);
      const setModels = (yield* readRequestLog(requestLog)).filter(
        (request) => request["type"] === "set_model",
      );
      expect(setModels).toEqual([
        { id: expect.any(String), type: "set_model", provider: "zai", modelId: "glm-5.3" },
        { id: expect.any(String), type: "set_model", provider: "moonshot", modelId: "kimi-k2" },
      ]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("follows omp's own resolution for the default selection: no modelId anywhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-default-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-default", sessionFile: "/tmp/fake-default.jsonl" },
            },
          },
          events: [
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("default");
      const defaultSelection = decodeModelSelection({
        instanceId: ids.instanceId,
        model: "default",
      });
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: defaultSelection,
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("hello omp"),
        modelSelection: defaultSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal");
      const requests = yield* readRequestLog(requestLog);
      expect(requests.some((request) => request["type"] === "set_model")).toBe(false);
      expect(requests.find((request) => request["type"] === "open_session")).toEqual({
        id: expect.any(String),
        type: "open_session",
        sessionDir: expect.stringContaining("/.t3code/omp-sessions"),
      });
      // A default thread stores no model metadata — omp keeps resolving on its own.
      const storedThread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
      expect(storedThread?.nativeMetadata?.modelSelection).toBeUndefined();
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("fails the turn start fail-closed when omp cannot select the model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-notfound-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-notfound", sessionFile: "/tmp/fake-notfound.jsonl" },
            },
            set_model: { success: false, error: "Model not found: zai/ghost-model" },
          },
          events: [],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("notfound");
      const ghostSelection = decodeModelSelection({
        instanceId: ids.instanceId,
        model: "zai/ghost-model",
      });
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ghostSelection,
        runtimePolicy,
      });
      // The prompt is never admitted and the omp error surfaces with re-selection guidance.
      const failure = yield* harness.runtime
        .startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage("hello omp"),
          modelSelection: ghostSelection,
          runtimePolicy,
        })
        .pipe(Effect.flip);
      if (failure._tag !== "ProviderAdapterProtocolError")
        throw new Error(`expected protocol error, got ${failure._tag}`);
      expect(failure.detail).toContain("Model not found: zai/ghost-model");
      expect(failure.detail).toContain("Re-select a model");
      const requests = yield* readRequestLog(requestLog);
      expect(requests.some((request) => request["type"] === "prompt")).toBe(false);
      const storedThread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
      // No silent rewrite: the metadata never claims the ghost model was applied.
      expect(storedThread?.nativeMetadata?.modelSelection).toBeUndefined();
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  // Thinking level (#21, spec §6/§7): the descriptor choice rides the turn's modelSelection
  // options ("thinking"); dispatch mirrors #17's idle-window model passthrough exactly —
  // startTurn's structural guard makes mid-turn switches unreachable, and a failed
  // set_thinking_level fails the turn start fail-closed, never a silent level fallback.
  const thinkingSelection = (instanceId: ProviderInstanceId, level: string) =>
    decodeModelSelection({
      instanceId,
      model: "zai/glm-5.3",
      options: [{ id: "thinking", value: level }],
    });

  live("applies the selected thinking level with set_thinking_level before the prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-thinking-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-thinking", sessionFile: "/tmp/fake-thinking.jsonl" },
            },
            set_thinking_level: { data: { level: "high" } },
          },
          events: [
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("thinking");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("hello omp"),
        modelSelection: thinkingSelection(ids.instanceId, "high"),
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal");
      const requests = yield* readRequestLog(requestLog);
      const setThinking = requests.find((request) => request["type"] === "set_thinking_level");
      expect(setThinking).toEqual({
        id: expect.any(String),
        type: "set_thinking_level",
        level: "high",
      });
      // Idle-window dispatch: the level lands in omp before the prompt, in the same window
      // as #17's set_model (before beginTurn flips the thread to running).
      const setThinkingIndex = requests.indexOf(setThinking!);
      const promptIndex = requests.findIndex((request) => request["type"] === "prompt");
      expect(promptIndex).toBeGreaterThan(setThinkingIndex);
      expect(
        harness.events.some(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("keeps the applied thinking level across turns and only sends it again on a change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-thinkkeep-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-thinkkeep", sessionFile: "/tmp/fake-thinkkeep.jsonl" },
            },
          },
          eventsPerRequest: {
            prompt: [
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("thinkkeep");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const startTurnWith = (selection: typeof ids.modelSelection, runOrdinal: number) =>
        harness.runtime.startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal,
          providerTurnOrdinal: runOrdinal,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage(`turn ${runOrdinal}`),
          modelSelection: selection,
          runtimePolicy,
        });
      yield* startTurnWith(thinkingSelection(ids.instanceId, "high"), 1);
      yield* waitFor(harness, "turn.terminal");
      // Same selection again: no redundant set_thinking_level.
      yield* startTurnWith(thinkingSelection(ids.instanceId, "high"), 2);
      yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 2);
      // A different level switches again.
      yield* startTurnWith(thinkingSelection(ids.instanceId, "off"), 3);
      yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 3);
      const setThinkings = (yield* readRequestLog(requestLog)).filter(
        (request) => request["type"] === "set_thinking_level",
      );
      expect(setThinkings).toEqual([
        { id: expect.any(String), type: "set_thinking_level", level: "high" },
        { id: expect.any(String), type: "set_thinking_level", level: "off" },
      ]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("fails the turn start fail-closed when omp rejects the thinking level", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-thinkfail-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-thinkfail", sessionFile: "/tmp/fake-thinkfail.jsonl" },
            },
            set_thinking_level: { success: false, error: "Unknown thinking level: xhigh" },
          },
          events: [],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("thinkfail");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      // The prompt is never admitted and the omp error surfaces with re-selection guidance.
      const failure = yield* harness.runtime
        .startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage("hello omp"),
          modelSelection: thinkingSelection(ids.instanceId, "xhigh"),
          runtimePolicy,
        })
        .pipe(Effect.flip);
      if (failure._tag !== "ProviderAdapterProtocolError")
        throw new Error(`expected protocol error, got ${failure._tag}`);
      expect(failure.detail).toContain("thinking level xhigh");
      expect(failure.detail).toContain("Unknown thinking level: xhigh");
      expect(failure.detail).toContain("Re-select a thinking level");
      const requests = yield* readRequestLog(requestLog);
      expect(requests.some((request) => request["type"] === "prompt")).toBe(false);
      // Exactly one dispatch attempt: no silent retry with a different level.
      expect(requests.filter((request) => request["type"] === "set_thinking_level")).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("restores the thread model through switch_session on recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-restore-" });
      const sessionFile = `${directory}/sessions/restore.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      void writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: { data: { sessionId: "s-restore", sessionFile } },
            switch_session: { data: { sessionId: "s-restore", sessionFile, resumed: true } },
          },
          events: [
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("restore");
      const command = `${directory}/omp`;
      let storedThread: OrchestrationV2ProviderThread | undefined;
      yield* Effect.gen(function* () {
        const first = yield* openHarness(ids, command);
        const providerThread = yield* first.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* first.runtime.startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage("first"),
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* waitFor(first, "turn.terminal");
        storedThread = eventsOf(first, "provider_thread.updated").at(-1)?.providerThread;
      }).pipe(Effect.scoped);
      // Fresh session runtime (process teardown): the metadata model must ride switch_session.
      yield* Effect.gen(function* () {
        const adapter = yield* makeOmpAdapterV2({ instanceId: ids.instanceId, command });
        const runtime2 = yield* adapter.openSession({
          threadId: ids.threadId,
          providerSessionId: ids.providerSessionId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        yield* runtime2.resumeThread({
          providerThread: storedThread as OrchestrationV2ProviderThread,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        const switches = (yield* readRequestLog(requestLog)).filter(
          (request) => request["type"] === "switch_session",
        );
        expect(switches).toEqual([
          {
            id: expect.any(String),
            type: "switch_session",
            sessionPath: sessionFile,
            provider: "zai",
            modelId: "glm-5.3",
          },
        ]);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("fails recovery closed when omp cannot restore the thread model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-ghost-" });
      const sessionFile = `${directory}/sessions/ghost.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      void writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: { data: { sessionId: "s-ghost", sessionFile } },
            // omp's fail-closed restore error: the saved model vanished from the catalog.
            switch_session: { success: false, error: "Could not restore model moonshot/kimi-k2" },
          },
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("ghost");
      const command = `${directory}/omp`;
      // Well-formed base thread from a throwaway runtime, then a fresh session runtime for the
      // recovery (production shape: resumeThread always lands on a runtime that never
      // registered the thread, so the stored identity is honored verbatim).
      let baseThread: OrchestrationV2ProviderThread | undefined;
      yield* Effect.gen(function* () {
        const first = yield* openHarness(ids, command);
        baseThread = yield* first.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
      }).pipe(Effect.scoped);
      // A thread whose selected model disappeared from the catalog keeps its selection;
      // recovery passes it verbatim and omp's restore failure surfaces — never a fallback.
      const ghostThread = {
        ...baseThread,
        nativeThreadRef: { driver: OMP_PROVIDER, nativeId: sessionFile, strength: "strong" },
        nativeMetadata: {
          modelSelection: { instanceId: ids.instanceId, model: "moonshot/kimi-k2" },
        },
      } as OrchestrationV2ProviderThread;
      yield* Effect.gen(function* () {
        const adapter = yield* makeOmpAdapterV2({ instanceId: ids.instanceId, command });
        const runtime = yield* adapter.openSession({
          threadId: ids.threadId,
          providerSessionId: ids.providerSessionId,
          modelSelection: ids.modelSelection,
          runtimePolicy,
        });
        const failure = yield* runtime
          .resumeThread({
            providerThread: ghostThread,
            modelSelection: ids.modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);
        if (failure._tag !== "ProviderAdapterResumeThreadError")
          throw new Error(`expected resume error, got ${failure._tag}`);
        const cause = failure.cause as { _tag?: string; detail?: string } | undefined;
        expect(cause?._tag).toBe("ProviderAdapterProtocolError");
        expect(cause?.detail).toContain("Could not restore model moonshot/kimi-k2");
        expect(cause?.detail).toContain("Re-select a model");
        const requests = yield* readRequestLog(requestLog);
        const switchRequest = requests.find((request) => request["type"] === "switch_session");
        // The vanished model rides the restore request verbatim — no dropping, no defaulting.
        expect(switchRequest).toEqual({
          id: expect.any(String),
          type: "switch_session",
          sessionPath: sessionFile,
          provider: "moonshot",
          modelId: "kimi-k2",
        });
        expect(requests.some((request) => request["type"] === "prompt")).toBe(false);
        expect(requests.some((request) => request["type"] === "set_model")).toBe(false);
        expect(requests.some((request) => request["type"] === "open_session")).toBe(false);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("rejects a model switch while a turn is active", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-busy-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-busy", sessionFile: "/tmp/fake-busy.jsonl" },
            },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "slow", contentIndex: 0 }),
            // Hold the terminal until abort: the first turn stays active for the probe.
            {
              afterRequestType: "abort",
              frame: { type: "prompt_result", agentInvoked: true, status: "aborted" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("busy");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("first"),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const moonshotSelection = decodeModelSelection({
        instanceId: ids.instanceId,
        model: "moonshot/kimi-k2",
      });
      // While the first turn runs, a second start (with a different model) is rejected.
      const failure = yield* harness.runtime
        .startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: decodeRunId("run-busy-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: decodeRunAttemptId("attempt-busy-2"),
          rootNodeId: decodeNodeId("node-busy-2"),
          providerThread,
          message: turnMessage("second"),
          modelSelection: moonshotSelection,
          runtimePolicy,
        })
        .pipe(Effect.flip);
      if (failure._tag !== "ProviderAdapterProtocolError")
        throw new Error(`expected protocol error, got ${failure._tag}`);
      expect(failure.reason).toBe("previous_turn_active");
      yield* harness.runtime.interruptTurn({
        providerThread,
        providerTurnId: IdAllocator.derive.providerTurn({
          driver: OMP_PROVIDER,
          nativeTurnId: `${providerThread.id}:t1:r1`,
        }),
      });
      yield* waitFor(harness, "turn.terminal", (event) => event.status === "interrupted");
      const setModels = (yield* readRequestLog(requestLog)).filter(
        (request) => request["type"] === "set_model",
      );
      // The rejected turn never reached omp: only the admitted turn's set_model exists.
      expect(setModels).toEqual([
        { id: expect.any(String), type: "set_model", provider: "zai", modelId: "glm-5.3" },
      ]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("syncs model_changed frames into thread metadata without a redundant set_model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-changed-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-changed", sessionFile: "/tmp/fake-changed.jsonl" },
            },
          },
          eventsPerRequest: {
            prompt: [
              { delayMs: 20, frame: { type: "model_changed", model: "moonshot/kimi-k2" } },
              { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
              {
                delayMs: 20,
                frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
              },
            ],
          },
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("changed");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("first"),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal");
      // omp switched models underneath us (e.g. cycle_model): metadata follows the report,
      // unfiltered — even a slug outside the current catalog keeps the thread's selection.
      const storedThread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
      expect(storedThread?.nativeMetadata?.modelSelection?.model).toBe("moonshot/kimi-k2");
      // The next turn on the reported model must not re-issue what omp already applied.
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread: storedThread as OrchestrationV2ProviderThread,
        message: turnMessage("second"),
        modelSelection: decodeModelSelection({
          instanceId: ids.instanceId,
          model: "moonshot/kimi-k2",
        }),
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal", (event) => event.runOrdinal === 2);
      const setModels = (yield* readRequestLog(requestLog)).filter(
        (request) => request["type"] === "set_model",
      );
      expect(setModels).toEqual([
        { id: expect.any(String), type: "set_model", provider: "zai", modelId: "glm-5.3" },
      ]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("passes image attachments as base64 prompt.images with mime preserved (D8)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-images-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-images",
                sessionFile: "/tmp/fake-images.jsonl",
              },
            },
          },
          eventsOnPrompt: [completedTurnEvents("seen")],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("images");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      // Source variants: bare attachment (no source) and a snap-shot source with
      // accessibleText. contracts give images no inline pixels — both read from the file.
      const pngImage: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("img-png"),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const jpegImage: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("img-jpeg"),
        name: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 4,
        source: {
          kind: "snap-shot",
          capturedAt: "1970-01-01T00:00:00.000Z",
          appName: "Preview",
          windowTitle: "photo.jpg",
          accessibleText: "a bar chart",
        },
      };
      yield* fs.writeFile(host.resolveAttachmentPath(pngImage)!, new Uint8Array([1, 2, 3]));
      yield* fs.writeFile(host.resolveAttachmentPath(jpegImage)!, new Uint8Array([4, 5, 6, 7]));
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("what do you see", [pngImage, jpegImage]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal");
      const prompt = (yield* readRequestLog(requestLog)).find(
        (request) => request["type"] === "prompt",
      );
      expect(prompt).toBeDefined();
      expect(prompt!["images"]).toEqual([
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "image", data: "BAUGBw==", mimeType: "image/jpeg" },
      ]);
      // Every attachment keeps a saved-path line in the message; the snapshot source adds its
      // captured-window context.
      const message = String(prompt!["message"]);
      expect(message).toContain(host.resolveAttachmentPath(pngImage)!);
      expect(message).toContain(host.resolveAttachmentPath(jpegImage)!);
      expect(message).toContain("screen.png");
      expect(message).toContain("Untrusted captured-window data");
      expect(message).toContain("Preview");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("extracts image bytes for snapshot sources with accessibility trees and app icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-snap-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-snap",
                sessionFile: "/tmp/fake-snap.jsonl",
              },
            },
          },
          eventsOnPrompt: [completedTurnEvents("ok")],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("snap");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const snapshotImage: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("img-snap"),
        name: "window.png",
        mimeType: "image/png",
        sizeBytes: 3,
        source: {
          kind: "snap-shot",
          capturedAt: "1970-01-01T00:00:00.000Z",
          appName: "Finder",
          windowTitle: "Projects",
          appIconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          accessibility: {
            format: "element-tree",
            coordinateSpace: "captured-image",
            imageSize: { width: 200, height: 100 },
            truncated: false,
            root: {
              role: "button",
              name: "OK",
              bounds: { x: 8, y: 8, width: 100, height: 24 },
              children: [],
            },
          },
        },
      };
      yield* fs.writeFile(host.resolveAttachmentPath(snapshotImage)!, new Uint8Array([1, 2, 3]));
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("describe the window", [snapshotImage]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal");
      const prompt = (yield* readRequestLog(requestLog)).find(
        (request) => request["type"] === "prompt",
      );
      expect(prompt!["images"]).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
      const message = String(prompt!["message"]);
      expect(message).toContain("Finder");
      expect(message).toContain("captured-image");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("degrades file attachments to saved-path lines without image parts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-files-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-files",
                sessionFile: "/tmp/fake-files.jsonl",
              },
            },
          },
          eventsOnPrompt: [completedTurnEvents("read it")],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("files");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const notesFile: ChatAttachment = {
        type: "file",
        id: ChatAttachmentId.make("file-notes"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
      };
      const pastedFile: ChatAttachment = {
        type: "file",
        id: ChatAttachmentId.make("file-pasted"),
        name: "snippet.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        source: { _tag: "pasted-text" },
      };
      yield* fs.writeFile(host.resolveAttachmentPath(notesFile)!, new Uint8Array([104, 105]));
      yield* fs.writeFile(host.resolveAttachmentPath(pastedFile)!, new Uint8Array([35]));
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("summarize these", [notesFile, pastedFile]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      // Not an error: the turn completes.
      yield* waitFor(harness, "turn.terminal", (event) => event.status === "completed");
      const prompt = (yield* readRequestLog(requestLog)).find(
        (request) => request["type"] === "prompt",
      );
      expect(prompt).toBeDefined();
      // No image parts: file attachments ride the message text only.
      expect(prompt!["images"]).toBeUndefined();
      const message = String(prompt!["message"]);
      expect(message).toContain('[Attached file "notes.txt" is saved at:');
      expect(message).toContain(host.resolveAttachmentPath(notesFile)!);
      expect(message).toContain('[Attached file "snippet.md" is saved at:');
      expect(message).toContain(host.resolveAttachmentPath(pastedFile)!);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("lists an unresolvable image attachment in the message without failing the turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-missing-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-missing",
                sessionFile: "/tmp/fake-missing.jsonl",
              },
            },
          },
          eventsOnPrompt: [completedTurnEvents("noted")],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("missing");
      const harness = yield* openHarness(ids, command, {
        resolveAttachmentPath: () => null,
      });
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const missingImage: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("missing-image"),
        name: "missing.png",
        mimeType: "image/png",
        sizeBytes: 0,
      };
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("look at this", [missingImage]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal", (event) => event.status === "completed");
      const prompt = (yield* readRequestLog(requestLog)).find(
        (request) => request["type"] === "prompt",
      );
      expect(prompt!["images"]).toBeUndefined();
      expect(String(prompt!["message"])).toContain(
        "[Attached image \"missing.png\" is unavailable: could not resolve a saved path for attachment 'missing-image'.]",
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("fails closed with an actionable error when image prompts exceed the frame limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-oversize-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-big",
                sessionFile: "/tmp/fake-big.jsonl",
              },
            },
          },
          // No events: the prompt must never reach omp.
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("big");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      // Two ~450 KiB images → ~1.2 MiB of base64: over the 1 MiB single-frame limit.
      const bigBytes = new Uint8Array(450_000).fill(65);
      const first: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("big-one"),
        name: "big-one.png",
        mimeType: "image/png",
        sizeBytes: 450_000,
      };
      const second: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("big-two"),
        name: "big-two.png",
        mimeType: "image/png",
        sizeBytes: 450_000,
      };
      yield* fs.writeFile(host.resolveAttachmentPath(first)!, bigBytes);
      yield* fs.writeFile(host.resolveAttachmentPath(second)!, bigBytes);
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("compare these", [first, second]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      const terminal = yield* waitFor(
        harness,
        "turn.terminal",
        (event) => event.status === "failed",
      );
      expect(terminal.failure?.message).toContain("single-frame RPC limit");
      expect(terminal.failure?.message).toContain("2 images");
      expect(terminal.failure?.message).toContain("Compress the attached images");
      // Fail closed: nothing went over the wire.
      expect(
        (yield* readRequestLog(requestLog)).some((request) => request["type"] === "prompt"),
      ).toBe(false);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("carries a large in-limit image prompt through to omp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-nearlimit-" });
      const requestLog = `${directory}/requests.jsonl`;
      const command = writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: {
                cancelled: false,
                resumed: false,
                sessionId: "s-near",
                sessionFile: "/tmp/fake-near.jsonl",
              },
            },
          },
          eventsOnPrompt: [completedTurnEvents("received")],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog },
      });
      const ids = makeIds("near");
      const harness = yield* openHarness(ids, command);
      const providerThread = yield* harness.runtime.ensureThread({
        threadId: ids.threadId,
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      // 700 KiB → ~933 KiB of base64: under the 1 MiB single-frame limit.
      const image: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("near-limit"),
        name: "near-limit.png",
        mimeType: "image/png",
        sizeBytes: 700_000,
      };
      yield* fs.writeFile(host.resolveAttachmentPath(image)!, new Uint8Array(700_000).fill(66));
      yield* harness.runtime.startTurn({
        appThread: appThreadFor(ids.threadId),
        threadId: ids.threadId,
        runId: ids.runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.attemptId,
        rootNodeId: ids.rootNodeId,
        providerThread,
        message: turnMessage("analyze this", [image]),
        modelSelection: ids.modelSelection,
        runtimePolicy,
      });
      yield* waitFor(harness, "turn.terminal", (event) => event.status === "completed");
      const prompt = (yield* readRequestLog(requestLog)).find(
        (request) => request["type"] === "prompt",
      );
      expect(prompt).toBeDefined();
      const images = prompt!["images"] as Array<{ type: string; data: string; mimeType: string }>;
      expect(images).toHaveLength(1);
      expect(images[0]!.type).toBe("image");
      expect(images[0]!.mimeType).toBe("image/png");
      expect(images[0]!.data).toBe(
        Buffer.from(new Uint8Array(700_000).fill(66)).toString("base64"),
      );
    }).pipe(Effect.provide(NodeTestLayer)),
  );
  live("projects omp approval dialogs and answers the three choices (D3)", () =>
    Effect.gen(function* () {
      const { harness, requestLog } = yield* startDrivenTurn(
        {
          responses: {
            open_session: {
              data: { sessionId: "s-approval", sessionFile: "/tmp/fake-approval.jsonl" },
            },
          },
          events: [
            {
              afterRequestType: "prompt",
              frame: approvalFrame("u1", "bash", [
                "Approve",
                "Approve bash for this session",
                "Deny",
              ]),
            },
            {
              afterRequestType: "prompt",
              frame: approvalFrame("u2", "edit", [
                "Deny",
                "Approve",
                "Approve edit for this session",
              ]),
            },
            {
              afterRequestType: "prompt",
              frame: approvalFrame("u3", "bash", ["Approve once", "Deny"]),
            },
            {
              afterRequestType: "prompt",
              frame: approvalFrame("u4", "bash", [
                "Approve",
                "Approve bash for this session",
                "Deny",
              ]),
            },
            // Held behind the first answer so the turn cannot settle via a startup-frame
            // replay while the dialogs are still being answered.
            {
              afterRequestType: "extension_ui_response",
              delayMs: 800,
              frame: { type: "agent_end", isTerminal: true },
            },
            {
              afterRequestType: "extension_ui_response",
              delayMs: 800,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        "approval",
      );
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- the fake child emits its dialogs on real time after the prompt lands.
      for (
        let attempt = 0;
        attempt < 500 && eventsOf(harness, "runtime_request.updated").length < 4;
        attempt += 1
      ) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- fake omp dialogs arrive on real time.
        yield* Effect.sleep(10);
      }
      const requests = eventsOf(harness, "runtime_request.updated").map(
        (event) => event.runtimeRequest,
      );
      expect(requests).toHaveLength(4);
      expect(requests.map((request) => request.nativeRequestRef?.nativeId)).toEqual([
        "u1",
        "u2",
        "u3",
        "u4",
      ]);
      expect(
        requests.every(
          (request) =>
            request.status === "pending" &&
            request.kind === "permission" &&
            request.providerTurnId !== null &&
            request.responseCapability.type === "live",
        ),
      ).toBe(true);
      // Approval turn item: the canonical spec §6 three-choice option set.
      const items = eventsOf(harness, "turn_item.updated").map((event) => event.turnItem);
      const approvals = items.filter((item) => item.type === "approval_request");
      expect(approvals).toHaveLength(4);
      const first = approvals[0];
      if (first?.type !== "approval_request") throw new Error("no approval item captured");
      expect(first.title).toBe("bash");
      expect(first.requestKind).toBe("permission");
      expect(first.options?.map((option) => option.label)).toEqual([
        "Approve",
        "Approve bash for this session",
        "Deny",
      ]);
      expect(first.options?.map((option) => option.decision)).toEqual([
        "accept",
        "acceptForSession",
        "decline",
      ]);
      expect(first.status).toBe("waiting");
      const approvalNodes = eventsOf(harness, "node.updated").filter(
        (event) => event.node.kind === "approval_request",
      );
      expect(approvalNodes).toHaveLength(4);
      expect(approvalNodes[0]?.node.runtimeRequestId).toBe(first.requestId);
      expect(approvalNodes[0]?.node.status).toBe("waiting");

      // Three-choice pass-through: each decision answers with the omp option string.
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: requests[0]!.id,
        decision: "accept",
      });
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: requests[1]!.id,
        decision: "acceptForSession",
      });
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: requests[2]!.id,
        decision: "decline",
      });
      // acceptAlways is never offered by omp (spec §6): refused without touching the wire.
      const alwaysRefused = yield* Effect.flip(
        harness.runtime.respondToRuntimeRequest({
          requestId: requests[3]!.id,
          decision: "acceptAlways",
        }),
      );
      expect(alwaysRefused._tag).toBe("ProviderAdapterRuntimeRequestResponseError");
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: requests[3]!.id,
        decision: "cancel",
      });
      const answeredTwice = yield* Effect.flip(
        harness.runtime.respondToRuntimeRequest({
          requestId: requests[3]!.id,
          decision: "accept",
        }),
      );
      expect(answeredTwice._tag).toBe("ProviderAdapterRuntimeRequestResponseError");

      yield* waitFor(harness, "turn.terminal");
      const wire = (yield* readRequestLog(requestLog)).filter(
        (request) => request["type"] === "extension_ui_response",
      );
      // The envelope id IS the omp dialog id; values are the exact omp option strings.
      expect(wire).toEqual([
        { id: "u1", type: "extension_ui_response", value: "Approve" },
        { id: "u2", type: "extension_ui_response", value: "Approve edit for this session" },
        { id: "u3", type: "extension_ui_response", value: "Deny" },
        { id: "u4", type: "extension_ui_response", cancelled: true },
      ]);
    }).pipe(Effect.provide(NodeTestLayer)),
  );
  live("queues a runtime-mode switch until the turn settles, then respawns (D4)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-modeswitch-" });
      const sessionFile = `${directory}/sessions/mode-switch.jsonl`;
      const requestLog = `${directory}/requests.jsonl`;
      const argvLog = `${directory}/argv.jsonl`;
      void writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: { data: { sessionId: "s-mode", sessionFile } },
          },
          events: [
            messageUpdate(20, { type: "text_delta", delta: "long turn", contentIndex: 0 }),
            { afterRequestType: "steer", frame: { type: "agent_end", isTerminal: true } },
            {
              afterRequestType: "steer",
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_REQUEST_LOG: requestLog, FAKE_OMP_ARGV_LOG: argvLog },
      });
      const ids = makeIds("modeswitch");
      const command = `${directory}/omp`;
      const supervised = {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/tmp",
      } satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;
      const fullAccess = {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/tmp",
      } satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(ids, command);
        const providerThread = yield* harness.runtime.ensureThread({
          threadId: ids.threadId,
          modelSelection: ids.modelSelection,
          runtimePolicy: supervised,
        });
        yield* harness.runtime.startTurn({
          appThread: appThreadFor(ids.threadId),
          threadId: ids.threadId,
          runId: ids.runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.attemptId,
          rootNodeId: ids.rootNodeId,
          providerThread,
          message: turnMessage("long running"),
          modelSelection: ids.modelSelection,
          runtimePolicy: supervised,
        });
        // Mid-turn switch request: queued, never a respawn (spec §6).
        yield* harness.runtime.resumeThread({
          providerThread,
          modelSelection: ids.modelSelection,
          runtimePolicy: fullAccess,
        });
        const beforeTurnEnd = yield* pollLogLines(argvLog, 1);
        expect(beforeTurnEnd).toEqual([["--mode", "rpc", "--approval-mode", "always-ask"]]);
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving the switch did NOT fire needs a real settle window.
        yield* Effect.sleep(150);
        expect(yield* readRequestLog(requestLog)).toEqual(
          expect.not.arrayContaining([expect.objectContaining({ type: "switch_session" })]),
        );
        const stillOneProcess = yield* pollLogLines(argvLog, 1);
        expect(stillOneProcess).toHaveLength(1);

        yield* harness.runtime.steerTurn({
          threadId: ids.threadId,
          runId: ids.runId,
          providerThread,
          providerTurnId: IdAllocator.derive.providerTurn({
            driver: OMP_PROVIDER,
            nativeTurnId: `${providerThread.id}:t1:r1`,
          }),
          message: turnMessage("finish up"),
        });
        const terminal = yield* waitFor(
          harness,
          "turn.terminal",
          (event) => event.status === "completed",
        );
        expect(terminal.status).toBe("completed");
        // The queued switch fires after the turn settles: drain → exit → respawn + switch_session.
        const afterTurnEnd = yield* pollLogLines(argvLog, 2);
        expect(afterTurnEnd[0]).toEqual(["--mode", "rpc", "--approval-mode", "always-ask"]);
        expect(afterTurnEnd[1]).toEqual(["--mode", "rpc", "--approval-mode", "yolo"]);
        const switches = yield* pollRequestLog(
          requestLog,
          (request) => request["type"] === "switch_session",
        );
        expect(switches).toHaveLength(1);
        expect(switches[0]?.["sessionPath"]).toBe(sessionFile);
        const requests = yield* readRequestLog(requestLog);
        expect(requests.filter((request) => request["type"] === "open_session")).toHaveLength(1);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  live("maps runtime modes onto --approval-mode spawn argv (spec §6)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-argvmap-" });
      const argvLog = `${directory}/argv.jsonl`;
      void writeFakeOmp({
        directory,
        program: {
          responses: {
            open_session: {
              data: { sessionId: "s-argv", sessionFile: "/tmp/fake-argv.jsonl" },
            },
          },
          events: [
            { delayMs: 20, frame: { type: "agent_end", isTerminal: true } },
            {
              delayMs: 20,
              frame: { type: "prompt_result", agentInvoked: true, status: "completed" },
            },
          ],
        },
        env: { FAKE_OMP_ARGV_LOG: argvLog },
      });
      const expected: ReadonlyArray<
        [ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"], ReadonlyArray<string>]
      > = [
        ["approval-required", ["--mode", "rpc", "--approval-mode", "always-ask"]],
        ["auto-accept-edits", ["--mode", "rpc", "--approval-mode", "write"]],
        ["full-access", ["--mode", "rpc", "--approval-mode", "yolo"]],
        // auto never declares a native approval mode (stored auto degrades server-side).
        ["auto", ["--mode", "rpc"]],
      ];
      yield* Effect.gen(function* () {
        const harness = yield* openHarness(makeIds("argvmap"), `${directory}/omp`);
        for (const [index, [mode, argv]] of expected.entries()) {
          const ids = makeIds(`argvmap${index}`);
          const policy = {
            runtimeMode: mode,
            interactionMode: "default",
            cwd: "/tmp",
          } satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;
          const providerThread = yield* harness.runtime.ensureThread({
            threadId: ids.threadId,
            modelSelection: ids.modelSelection,
            runtimePolicy: policy,
          });
          yield* harness.runtime.startTurn({
            appThread: appThreadFor(ids.threadId),
            threadId: ids.threadId,
            runId: ids.runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: ids.attemptId,
            rootNodeId: ids.rootNodeId,
            providerThread,
            message: turnMessage(mode),
            modelSelection: ids.modelSelection,
            runtimePolicy: policy,
          });
          const lines = yield* pollLogLines(argvLog, index + 1);
          expect(lines[index]).toEqual(argv);
        }
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(NodeTestLayer)),
  );
});
