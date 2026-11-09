// omp adapter lifeline tests (ticket #15 / spec §5.4/5.5): a fake omp JSONL child drives each
// event sequence; assertions target the SessionRuntime public seam (openSession → ensureThread →
// startTurn → events stream) and the §5.5 contract hard constraints.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, live } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import {
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
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeOmpAdapterV2 } from "./adapter.ts";
import { OMP_PROVIDER } from "./kind.ts";
import { writeFakeOmp, type FakeOmpProgram } from "../testing.ts";

const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeMessageId = Schema.decodeSync(MessageId);
const decodeRunId = Schema.decodeSync(RunId);
const decodeRunAttemptId = Schema.decodeSync(RunAttemptId);
const decodeNodeId = Schema.decodeSync(NodeId);
const decodeProviderSessionId = Schema.decodeSync(ProviderSessionId);
const decodeProviderInstanceId = Schema.decodeSync(ProviderInstanceId);
const decodeModelSelection = Schema.decodeSync(ModelSelection);

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

const turnMessage = (text: string): ProviderAdapter.ProviderAdapterV2TurnMessage => ({
  messageId: decodeMessageId(`msg-${Math.abs(text.length * 31)}`),
  text,
  attachments: [],
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

/** Opens a session, starts eagerly collecting events, and returns the runtime harness. */
const openHarness = Effect.fn("adapterTest.openHarness")(function* (
  ids: ReturnType<typeof makeIds>,
  command: string,
) {
  const scope = yield* Effect.scope;
  const adapter = yield* makeOmpAdapterV2({ instanceId: ids.instanceId, command });
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

/** Spawns the fake omp, opens a session, registers a thread, and starts a turn. */
const startDrivenTurn = Effect.fn("adapterTest.startDrivenTurn")(function* (
  program: FakeOmpProgram,
  suffix: string,
  options: {
    readonly message?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: `omp-adapter-${suffix}-` });
  const requestLog = `${directory}/requests.jsonl`;
  const command = writeFakeOmp({ directory, program, env: { FAKE_OMP_REQUEST_LOG: requestLog } });
  void command;
  const ids = makeIds(suffix);
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
    message: turnMessage(options.message ?? "hello omp"),
    modelSelection: ids.modelSelection,
    runtimePolicy,
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
      // open_session with no args: first spawn lets omp create the session.
      expect(openSessionRequest).toEqual({ id: expect.any(String), type: "open_session" });
      const promptRequest = requests.find((request) => request["type"] === "prompt");
      expect(promptRequest?.["message"]).toBe("hello omp");
      expect(promptRequest?.["streamingBehavior"]).toBe("followUp");
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
      });
      // A default thread stores no model metadata — omp keeps resolving on its own.
      const storedThread = eventsOf(harness, "provider_thread.updated").at(-1)?.providerThread;
      expect(storedThread?.nativeMetadata?.modelSelection).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
