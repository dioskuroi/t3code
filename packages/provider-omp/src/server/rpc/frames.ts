// omp RPC JSONL v2 frame facts (spec §5.2/5.3; see migration notes rpc-protocol.md).
import * as Schema from "effect/Schema";

export class OmpProtocolUnsupportedError extends Schema.TaggedError<OmpProtocolUnsupportedError>()(
  "OmpProtocolUnsupportedError",
  {
    operation: Schema.Literals(["negotiate_protocol"]),
    supportedProtocolVersions: Schema.Array(Schema.Number),
  },
) {
  override get message(): string {
    const versions = this.supportedProtocolVersions.join(", ") || "none";
    return (
      `omp does not support RPC protocol v2 (supported versions: ${versions}). ` +
      "Upgrade the omp CLI to the latest version and refresh the provider status."
    );
  }
}

export const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

export interface OmpReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
}

export interface OmpResponseFrame {
  readonly type: "response";
  readonly id: string | number | undefined;
  readonly command: string | undefined;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

export type OmpRpcFrame = Record<string, unknown>;

const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);

export function parseOmpRpcFrame(line: string): OmpRpcFrame | undefined {
  try {
    const parsed = decodeJsonLine(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as OmpRpcFrame) : undefined;
  } catch {
    return undefined;
  }
}

export function isOmpReadyFrame(frame: OmpRpcFrame): frame is OmpRpcFrame & OmpReadyFrame {
  return (
    frame["type"] === "ready" &&
    typeof frame["protocolVersion"] === "number" &&
    Array.isArray(frame["supportedProtocolVersions"])
  );
}

export function isOmpResponseFrame(frame: OmpRpcFrame): frame is OmpRpcFrame & OmpResponseFrame {
  return frame["type"] === "response";
}

const OMP_RPC_PROTOCOL_VERSION = 2;

export function ompSupportsProtocolV2(ready: OmpRpcFrame & OmpReadyFrame): boolean {
  return ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION);
}

/** omp advertises both limits in the ready frame; these are the observed defaults (notes §1/§2). */
export const OMP_DEFAULT_MAX_FRAME_BYTES = 1_048_576;
export const OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES = 67_108_864;

export interface OmpFrameDecoderLimits {
  readonly maxReassembledFrameBytes?: number;
}

export interface OmpFrameDecoderOutput {
  /** Complete frames ready for dispatch, in arrival order. */
  readonly frames: ReadonlyArray<OmpRpcFrame>;
  /** Set when a rpc_chunk sequence violated the reassembly rules — callers fail closed. */
  readonly error: string | undefined;
}

/**
 * Reassembles v2 `rpc_chunk` sequences ({chunkId, index, count, byteLength, data: base64}).
 * Rejects interleaved or interrupted sequences, byteLength mismatches, and payloads over the
 * advertised cap; everything is fail-closed (notes §2).
 */
export function makeOmpFrameDecoder(
  limits: OmpFrameDecoderLimits = {},
): (frame: OmpRpcFrame) => OmpFrameDecoderOutput {
  const maxReassembled = limits.maxReassembledFrameBytes ?? OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES;
  const utf8Strict = new TextDecoder("utf-8", { fatal: true });

  let activeChunkId: string | undefined;
  let expectedIndex = 0;
  let expectedCount = 0;
  let declaredByteLength = 0;
  let accumulatedBytes = 0;
  let chunks: Array<string> = [];

  const reset = () => {
    activeChunkId = undefined;
    expectedIndex = 0;
    expectedCount = 0;
    declaredByteLength = 0;
    accumulatedBytes = 0;
    chunks = [];
  };

  const chunkField = (frame: OmpRpcFrame, key: string): string | undefined =>
    typeof frame[key] === "string" ? (frame[key] as string) : undefined;
  const chunkNumber = (frame: OmpRpcFrame, key: string): number | undefined =>
    typeof frame[key] === "number" ? (frame[key] as number) : undefined;

  return (frame: OmpRpcFrame): OmpFrameDecoderOutput => {
    if (frame["type"] !== "rpc_chunk") {
      if (activeChunkId !== undefined) {
        const error = `rpc_chunk sequence ${activeChunkId} interrupted by a non-chunk frame`;
        reset();
        return { frames: [], error };
      }
      return { frames: [frame], error: undefined };
    }

    const chunkId = chunkField(frame, "chunkId");
    const index = chunkNumber(frame, "index");
    const count = chunkNumber(frame, "count");
    const byteLength = chunkNumber(frame, "byteLength");
    const data = chunkField(frame, "data");
    if (
      chunkId === undefined ||
      index === undefined ||
      count === undefined ||
      byteLength === undefined ||
      data === undefined ||
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isInteger(index) ||
      index < 0 ||
      byteLength < 0
    ) {
      const error = "Malformed rpc_chunk frame";
      reset();
      return { frames: [], error };
    }

    if (activeChunkId === undefined) {
      if (index !== 0) {
        reset();
        return { frames: [], error: `rpc_chunk sequence starts at index ${index}` };
      }
      if (byteLength > maxReassembled) {
        reset();
        return {
          frames: [],
          error: `rpc_chunk payload of ${byteLength} bytes exceeds the ${maxReassembled}-byte reassembly limit`,
        };
      }
      activeChunkId = chunkId;
      expectedIndex = 0;
      expectedCount = count;
      declaredByteLength = byteLength;
      accumulatedBytes = 0;
      chunks = [];
    } else if (chunkId !== activeChunkId || index !== expectedIndex || count !== expectedCount) {
      const error = `rpc_chunk sequence ${activeChunkId} got interleaved or out-of-order chunk ${chunkId}[${index}]`;
      reset();
      return { frames: [], error };
    }

    const decoded = Buffer.from(data, "base64");
    accumulatedBytes += decoded.byteLength;
    chunks.push(decoded.toString("binary"));
    expectedIndex += 1;

    if (accumulatedBytes > maxReassembled) {
      reset();
      return {
        frames: [],
        error: `rpc_chunk payload exceeded the ${maxReassembled}-byte reassembly limit`,
      };
    }
    if (expectedIndex < expectedCount) return { frames: [], error: undefined };

    const byteLengthValue = Buffer.concat(chunks.map((stored) => Buffer.from(stored, "binary")));
    const declaredByteLengthValue = declaredByteLength;
    reset();
    if (byteLengthValue.byteLength !== declaredByteLengthValue) {
      return {
        frames: [],
        error: `rpc_chunk sequence declared ${declaredByteLengthValue} bytes but carried ${byteLengthValue.byteLength}`,
      };
    }
    try {
      const text = utf8Strict.decode(byteLengthValue);
      const parsed = parseOmpRpcFrame(text);
      if (parsed === undefined)
        return { frames: [], error: "Reassembled frame is not a JSON object" };
      return { frames: [parsed], error: undefined };
    } catch {
      return { frames: [], error: "Reassembled frame is not valid UTF-8" };
    }
  };
}
