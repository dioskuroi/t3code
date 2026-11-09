// Long-lived omp RPC client (spec §5.2): spawn `omp --mode rpc`, wait for the ready frame,
// negotiate protocol v2, multiplex requests with a pending map + 30s fail-closed timeout,
// subscribe to events, and drain stdout to EOF after closing stdin (notes §7).
// @effect-diagnostics preferSchemaOverJson:off - the wire is an untyped JSON envelope; Schema would add decoding without removing any failure mode the pending-map timeout already covers.
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  OMP_DEFAULT_MAX_FRAME_BYTES,
  OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
  OmpProtocolUnsupportedError,
  isOmpReadyFrame,
  isOmpResponseFrame,
  makeOmpFrameDecoder,
  ompSupportsProtocolV2,
  parseOmpRpcFrame,
  type OmpReadyFrame,
  type OmpRpcFrame,
} from "./frames.ts";

const OMP_READY_TIMEOUT_MS = 15_000;
const OMP_REQUEST_TIMEOUT_MS = 30_000;
const OMP_NEGOTIATED_PROTOCOL_VERSION = 2;

export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `omp RPC ${this.operation} failed: ${this.detail}`;
  }
}

export class OmpRpcTimeoutError extends Schema.TaggedError<OmpRpcTimeoutError>()(
  "OmpRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `omp RPC ${this.operation} timed out after ${this.timeoutMs}ms`;
  }
}

export class OmpRpcExitError extends Schema.TaggedError<OmpRpcExitError>()("OmpRpcExitError", {
  exitCode: Schema.NullOr(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `omp RPC process exited unexpectedly (code ${String(this.exitCode)}): ${this.detail}`;
  }
}

export type OmpRpcRequestError = OmpRpcError | OmpRpcTimeoutError | OmpRpcExitError;

export interface OmpRpcClientSpawnOptions {
  /** Resolved executable; defaults to `omp` (PATH discovery). */
  readonly command?: string | undefined;
  readonly args?: ReadonlyArray<string>;
  readonly shell?: boolean | undefined;
  readonly cwd?: string | undefined;
  /** Defaults to process.env (extendEnv), per spec §5.2. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** stderr arrives as raw chunks; wire this to the T3 server log. */
  readonly onStderr?: (chunk: string) => void;
  /** Every decoded event frame (ready/response/chunks excluded) is forwarded here. */
  readonly onEvent?: (frame: OmpRpcFrame) => void;
  /** Fires exactly once when the child exits for any reason; close() is the orderly path. */
  readonly onExit?: (exit: { readonly exitCode: number | null }) => void;
  readonly readyTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface OmpRpcClient {
  /** Negotiated protocol version (always 2 — construction fails closed otherwise). */
  readonly protocolVersion: number;
  /**
   * Sends `{ id, type, ...params }` and resolves with the response `data`. Fails closed on
   * request failure, 30s silence (injectable clock), chunk decode failure, or child exit.
   */
  readonly request: (
    type: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, OmpRpcRequestError>;
  /**
   * Closes stdin, keeps reading stdout until EOF, and resolves with the child's exit code.
   * Resolves with a nonzero code (not an error) so callers can distinguish drain semantics.
   */
  readonly close: Effect.Effect<number | null, never>;
}

interface PendingRequest {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, OmpRpcRequestError>;
}

const errorDetail = (error: unknown): string =>
  typeof error === "string" && error.trim() !== "" ? error : "request failed";

export const makeOmpRpcClient = Effect.fnUntraced(function* (options: OmpRpcClientSpawnOptions) {
  const scope = yield* Effect.scope;
  const requestTimeoutMs = options.requestTimeoutMs ?? OMP_REQUEST_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? OMP_READY_TIMEOUT_MS;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(options.command ?? "omp", [...(options.args ?? ["--mode", "rpc"])], {
      env: options.env,
      extendEnv: true,
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdin: { stream: "pipe" },
    }),
  );

  let maxFrameBytes = OMP_DEFAULT_MAX_FRAME_BYTES;
  // Rebuilt when the ready frame advertises a different reassembly cap (notes §1/§2).
  let decoder = makeOmpFrameDecoder({
    maxReassembledFrameBytes: OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
  });
  const frames = yield* Queue.unbounded<OmpRpcFrame>();
  const pending = new Map<string, PendingRequest>();
  let exited = false;
  let exitCode: number | null = null;
  let exitObserved = false;
  const exitDeferred = yield* Deferred.make<number | null, OmpRpcError>();

  const failAllPending = Effect.fn("OmpRpc.failAllPending")(function* (error: OmpRpcRequestError) {
    for (const request of pending.values()) {
      yield* Deferred.fail(request.deferred, error);
    }
    pending.clear();
  });

  const onExitWatchFailure = Effect.fn("OmpRpc.onExitWatchFailure")(function* (cause: unknown) {
    exited = true;
    yield* failAllPending(
      new OmpRpcExitError({ exitCode: null, detail: `exit watch failed: ${String(cause)}` }),
    );
    yield* Deferred.fail(
      exitDeferred,
      new OmpRpcError({ operation: "exit", detail: String(cause) }),
    );
  });

  const onExitObserved = Effect.fn("OmpRpc.onExitObserved")(function* (raw: number | null) {
    exitCode = raw;
    exited = true;
    yield* failAllPending(
      new OmpRpcExitError({
        exitCode,
        detail: "process exited before the response arrived",
      }),
    );
    exitObserved = true;
    yield* Effect.sync(() => options.onExit?.({ exitCode }));
    yield* Deferred.succeed(exitDeferred, exitCode);
  });

  // Exit watcher: registered before the reader so crashes fail requests immediately.
  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: onExitWatchFailure,
      onSuccess: onExitObserved,
    }),
    Effect.forkIn(scope),
  );

  const dispatchFrame = Effect.fn("OmpRpc.dispatchFrame")(function* (frame: OmpRpcFrame) {
    if (isOmpResponseFrame(frame)) {
      const id = frame.id === undefined ? undefined : String(frame.id);
      if (id === undefined) return;
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      if (frame.success) {
        yield* Deferred.succeed(request.deferred, frame.data);
      } else {
        yield* Deferred.fail(
          request.deferred,
          new OmpRpcError({ operation: request.operation, detail: errorDetail(frame.error) }),
        );
      }
      return;
    }
    yield* Queue.offer(frames, frame);
  });

  // Reader fiber lives until stdout EOF — closing stdin later never orphans in-flight output.
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const frame = parseOmpRpcFrame(line);
        if (frame === undefined) return;
        const output = decoder(frame);
        if (output.error !== undefined) {
          yield* failAllPending(new OmpRpcError({ operation: "rpc_chunk", detail: output.error }));
          return;
        }
        for (const decoded of output.frames) {
          if (isOmpReadyFrame(decoded)) {
            maxFrameBytes =
              typeof decoded.maxFrameBytes === "number" && decoded.maxFrameBytes > 0
                ? decoded.maxFrameBytes
                : OMP_DEFAULT_MAX_FRAME_BYTES;
            const advertisedReassembled = decoded.maxReassembledFrameBytes;
            if (
              typeof advertisedReassembled === "number" &&
              advertisedReassembled > 0 &&
              advertisedReassembled !== OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES
            ) {
              decoder = makeOmpFrameDecoder({ maxReassembledFrameBytes: advertisedReassembled });
            }
          }
          if (isOmpResponseFrame(decoded) || isOmpReadyFrame(decoded)) {
            yield* dispatchFrame(decoded);
          } else {
            // Event frame: forward after reassembly; callback defects must not kill the reader.
            yield* Effect.sync(() => {
              return options.onEvent?.(decoded);
            }).pipe(Effect.ignore);
          }
        }
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        if (options.onStderr !== undefined) options.onStderr(chunk);
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  // Writer: shutting the queue down ends the stream, which closes stdin (endOnDone default).
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  const takeReadyFrame = Effect.fn("OmpRpc.takeReadyFrame")(function* () {
    while (true) {
      const frame = yield* Queue.take(frames);
      if (isOmpReadyFrame(frame)) return frame as OmpRpcFrame & OmpReadyFrame;
    }
  });

  const ready = yield* Effect.raceFirst(
    takeReadyFrame(),
    Deferred.await(exitDeferred).pipe(
      Effect.flatMap(
        (code) =>
          new OmpRpcExitError({
            exitCode: code,
            detail: "exited before sending a ready frame",
          }),
      ),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(readyTimeoutMs),
      orElse: () =>
        Effect.fail(
          new OmpRpcError({
            operation: "ready",
            detail: `No ready frame within ${readyTimeoutMs}ms`,
          }),
        ),
    }),
  );

  if (!ompSupportsProtocolV2(ready)) {
    // Close stdin so the child drains and exits instead of leaking (notes §7).
    yield* Queue.shutdown(outgoing);
    return yield* new OmpProtocolUnsupportedError({
      operation: "negotiate_protocol",
      supportedProtocolVersions: [...ready.supportedProtocolVersions],
    });
  }

  let nextRequestId = 0;
  const request = Effect.fn("OmpRpc.request")(function* (
    type: string,
    params: Record<string, unknown> = {},
  ): Effect.fn.Return<unknown, OmpRpcRequestError> {
    if (exited) {
      return yield* new OmpRpcExitError({
        exitCode,
        detail: "omp RPC process has already exited",
      });
    }
    // omp echoes the request id. extension_ui_response carries the omp dialog id in params.id —
    // make it the envelope id so the echoed response resolves the pending entry instead of
    // racing a phantom t3-N id into the 30s timeout.
    const id =
      typeof params["id"] === "string" && params["id"] !== ""
        ? params["id"]
        : `t3-${nextRequestId++}`;
    const payload = new TextEncoder().encode(JSON.stringify({ id, type, ...params }) + "\n");
    // Fail closed over the server-advertised single-frame transport limit (notes §2).
    if (payload.byteLength > maxFrameBytes) {
      return yield* new OmpRpcError({
        operation: type,
        detail: `Request of ${payload.byteLength} bytes exceeds the ${maxFrameBytes}-byte single-frame limit`,
      });
    }
    const deferred = yield* Deferred.make<unknown, OmpRpcRequestError>();
    pending.set(id, { operation: type, deferred });
    yield* Queue.offer(outgoing, payload);
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(requestTimeoutMs),
        orElse: () =>
          Effect.suspend(() => {
            pending.delete(id);
            return Effect.fail(
              new OmpRpcTimeoutError({ operation: type, timeoutMs: requestTimeoutMs }),
            );
          }),
      }),
      Effect.onError(() => Effect.sync(() => pending.delete(id))),
    );
  });

  const negotiation = yield* request("negotiate_protocol", {
    protocolVersion: OMP_NEGOTIATED_PROTOCOL_VERSION,
  });
  const negotiatedVersion = (negotiation as { protocolVersion?: unknown } | undefined)
    ?.protocolVersion;
  if (negotiatedVersion !== OMP_NEGOTIATED_PROTOCOL_VERSION) {
    yield* Queue.shutdown(outgoing);
    return yield* new OmpRpcError({
      operation: "negotiate_protocol",
      detail: `omp refused protocol v2 (negotiated ${String(negotiatedVersion)})`,
    });
  }
  // Event subscriptions (spec §5.2): delta message updates + full subagent event feed.
  // Real omp requires the `events` key (null = all events); verified against omp 18.18.1.
  yield* request("set_event_filter", { events: null, messageUpdates: "delta" });
  yield* request("set_subagent_subscription", { level: "events" });

  const close: Effect.Effect<number | null> = Effect.suspend(() =>
    Effect.gen(function* () {
      if (!exitObserved) {
        yield* Queue.shutdown(outgoing);
      }
      // The reader keeps draining until stdout EOF; exitDeferred resolves on real process exit.
      yield* Deferred.await(exitDeferred).pipe(Effect.ignore);
      return exitCode;
    }),
  );

  return {
    protocolVersion: OMP_NEGOTIATED_PROTOCOL_VERSION,
    request,
    close,
  } satisfies OmpRpcClient;
});
