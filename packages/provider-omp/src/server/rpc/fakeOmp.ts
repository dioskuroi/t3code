// Scriptable fake omp JSONL v2 child process (spec §5.2 / ticket #14 test harness).
// The program is plain JSON baked into the fake CLI via a sidecar env file, so every
// adapter test from #14 onward can drive deterministic frame sequences without a real omp.
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const FAKE_OMP_PROGRAM_ENV = "FAKE_OMP_PROGRAM";

export interface FakeOmpResponseSpec {
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /** Never answer — drives the client's fail-closed request timeout. */
  readonly never?: boolean;
  /** Send as a v2 rpc_chunk sequence with roughly this many bytes per chunk frame. */
  readonly chunkBytes?: number;
}

export interface FakeOmpTimedFrame {
  readonly delayMs?: number;
  /**
   * Hold this frame until the fake sees a request of the given command type, then send it.
   * Deterministic turn-boundary events (prompt_result after abort, agent_end after steer)
   * must not race the host's turn setup, which can take hundreds of ms under parallel tests.
   */
  readonly afterRequestType?: string;
  readonly frame: Record<string, unknown>;
}

/** A scripted stderr chunk written after the ready frame (#18 stderr wiring tests). */
export interface FakeOmpTimedStderr {
  readonly delayMs?: number;
  readonly text: string;
}

export interface FakeOmpProgram {
  readonly supportedProtocolVersions?: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
  /** Respond to negotiate_protocol with success:false. */
  readonly refuseNegotiation?: boolean;
  /** Frames emitted after the ready frame (in order, optional delays). */
  readonly events?: ReadonlyArray<FakeOmpTimedFrame>;
  /**
   * Scripted event sequences replayed per prompt request: the nth `prompt` request flushes
   * the nth sequence (multi-turn driving for lifecycle tests, #18).
   */
  readonly eventsOnPrompt?: ReadonlyArray<ReadonlyArray<FakeOmpTimedFrame>>;
  /** stderr chunks written after the ready frame (stderr wiring, #18). */
  readonly stderrOnReady?: ReadonlyArray<FakeOmpTimedStderr>;
  /**
   * Frames emitted on every request of the given command type (optional delays) — drives
   * repeatable same-process turn completions (e.g. prompt → agent_end + prompt_result).
   */
  readonly eventsPerRequest?: Record<string, ReadonlyArray<FakeOmpTimedFrame>>;
  /** Response behavior per command type; unlisted commands answer success with `data`. */
  readonly responses?: Record<string, FakeOmpResponseSpec>;
  /** Frames flushed after stdin EOF, before exit — proves the caller kept draining stdout. */
  readonly framesOnStdinEnd?: ReadonlyArray<Record<string, unknown>>;
  /** Process exit code once stdin closes (default 0). */
  readonly exitCodeOnStdinEnd?: number;
  /** Simulate a crash: exit with this code after N ms without waiting for stdin EOF. */
  readonly crash?: { readonly delayMs: number; readonly exitCode: number };
}

/**
 * Node source for a self-contained fake omp binary. Behavior is driven entirely by the
 * FAKE_OMP_PROGRAM env sidecar written by `writeFakeOmp`.
 */
function createFakeOmpSource(): string {
  return `
import { appendFileSync } from "node:fs";
const program = JSON.parse(process.env[${JSON.stringify(FAKE_OMP_PROGRAM_ENV)}] ?? "{}");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const sleep = (ms) => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
};
if (process.argv.includes("--version")) {
  process.stdout.write("omp/18.18.1\\n");
  process.exit(0);
}
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: program.supportedProtocolVersions ?? [1, 2],
  ...(program.maxFrameBytes !== undefined ? { maxFrameBytes: program.maxFrameBytes } : {}),
  ...(program.maxReassembledFrameBytes !== undefined
    ? { maxReassembledFrameBytes: program.maxReassembledFrameBytes }
    : {}),
});
for (const timed of program.stderrOnReady ?? []) {
  if (timed.delayMs !== undefined) await sleep(timed.delayMs);
  process.stderr.write(timed.text);
}
if (process.env.FAKE_OMP_EXIT_LOG) {
  const exitLog = process.env.FAKE_OMP_EXIT_LOG;
  process.on("exit", () => appendFileSync(exitLog, String(process.exitCode ?? 0)));
}
let promptCount = 0;
const respond = (request) => {
  const type = typeof request.type === "string" ? request.type : "";
  if (type === "negotiate_protocol") {
    if (program.refuseNegotiation === true) {
      send({ id: request.id, type: "response", command: type, success: false, error: "unsupported protocol" });
    } else {
      send({ id: request.id, type: "response", command: type, success: true, data: { protocolVersion: request.protocolVersion } });
    }
    return;
  }
  if (type === "set_event_filter" || type === "set_subagent_subscription") {
    if (type === "set_event_filter" && !("events" in request)) {
      send({ id: request.id, type: "response", command: type, success: false, error: "events must be null or an array of non-empty event type strings" });
      return;
    }
    send({ id: request.id, type: "response", command: type, success: true, data: {} });
    return;
  }
  const spec = (program.responses ?? {})[type] ?? { success: true, data: {} };
  if (spec.never === true) return;
  if (type === "prompt" && Array.isArray(program.eventsOnPrompt)) {
    const sequence = program.eventsOnPrompt[promptCount];
    promptCount += 1;
    if (sequence !== undefined) {
      for (const timed of sequence) {
        setTimeout(() => send(timed.frame), timed.delayMs ?? 0);
      }
    }
  }
  const payload = JSON.stringify({
    id: request.id,
    type: "response",
    command: type,
    success: spec.success ?? true,
    ...(spec.error !== undefined ? { error: spec.error } : { data: spec.data }),
  });
  if (spec.chunkBytes === undefined) {
    process.stdout.write(payload + "\\n");
    return;
  }
  // v2 framing: split the encoded response into base64 rpc_chunk frames (notes §2).
  const bytes = Buffer.from(payload, "utf8");
  const chunkBytes = Math.max(1, Math.min(spec.chunkBytes, bytes.byteLength));
  const count = Math.ceil(bytes.byteLength / chunkBytes);
  const chunkId = "rpc-0";
  for (let index = 0; index < count; index += 1) {
    const slice = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    send({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.byteLength, data: slice.toString("base64") });
  }
};
const heldEvents = [];
for (const timed of program.events ?? []) {
  if (timed.afterRequestType !== undefined) {
    heldEvents.push(timed);
    continue;
  }
  if (timed.delayMs !== undefined) await sleep(timed.delayMs);
  send(timed.frame);
}
const releaseHeld = (requestType) => {
  let index = 0;
  while (index < heldEvents.length) {
    const timed = heldEvents[index];
    if (timed.afterRequestType !== requestType) {
      index += 1;
      continue;
    }
    heldEvents.splice(index, 1);
    setTimeout(() => send(timed.frame), timed.delayMs ?? 0);
  }
};
const emitPerRequest = (requestType) => {
  const timeds = (program.eventsPerRequest ?? {})[requestType];
  if (timeds === undefined) return;
  let cumulativeDelay = 0;
  for (const timed of timeds) {
    cumulativeDelay += timed.delayMs ?? 0;
    setTimeout(() => send(timed.frame), cumulativeDelay);
  }
};
if (program.crash !== undefined) {
  setTimeout(() => process.exit(program.crash.exitCode), program.crash.delayMs);
}
let buffer = "";
const requestLog = process.env.FAKE_OMP_REQUEST_LOG;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (requestLog) appendFileSync(requestLog, JSON.stringify(request) + "\\n");
    respond(request);
    releaseHeld(request.type);
    emitPerRequest(request.type);
  }
});
process.stdin.on("end", () => {
  for (const frame of program.framesOnStdinEnd ?? []) send(frame);
  if (process.env.FAKE_OMP_DRAIN_MARKER) appendFileSync(process.env.FAKE_OMP_DRAIN_MARKER, "drained");
  process.exit(program.exitCodeOnStdinEnd ?? 0);
});
`;
}

export interface WriteFakeOmpOptions {
  readonly directory: string;
  readonly program?: FakeOmpProgram;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Writes a fake `omp` executable whose behavior is the given program. Returns the launcher
 * path — hand it to `makeOmpRpcClient({ command, args: [] })` or `checkOmpProviderStatus`.
 */
export function writeFakeOmp(options: WriteFakeOmpOptions): string {
  return writeFakeCli({
    directory: options.directory,
    name: "omp",
    source: createFakeOmpSource(),
    env: {
      ...options.env,
      ...(options.program !== undefined
        ? { [FAKE_OMP_PROGRAM_ENV]: JSON.stringify(options.program) }
        : {}),
    },
  });
}
