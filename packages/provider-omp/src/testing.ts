// Replay-testkit surface (spec §5.1). M1 exposes the status probe; the RPC frame facts and
// event-projection internals join it when the full client lands (#14).
export { checkOmpProviderStatus, OmpProtocolUnsupportedError } from "./server/status.ts";
export {
  isOmpReadyFrame,
  isOmpResponseFrame,
  ompSupportsProtocolV2,
  parseOmpRpcFrame,
} from "./server/rpc/frames.ts";
