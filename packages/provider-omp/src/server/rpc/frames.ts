// Minimal omp RPC JSONL v2 frame facts (spec §5.2/5.3; see migration notes rpc-protocol.md).
// The full client (request multiplexing, rpc_chunk reassembly, event subscriptions) lands with
// the adapter in #14; this module only carries what the status check needs today.
import * as Schema from "effect/Schema";

export const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

export interface OmpReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
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
