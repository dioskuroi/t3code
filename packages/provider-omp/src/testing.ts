// Replay-testkit surface (spec §5.1): status probe, RPC client, frame facts, and the fake
// omp harness used by this package's tests and every adapter test from #15 onward.
export { checkOmpProviderStatus } from "./server/status.ts";
export {
  makeOmpRpcClient,
  OmpRpcError,
  OmpRpcExitError,
  OmpRpcTimeoutError,
  type OmpRpcClient,
  type OmpRpcClientSpawnOptions,
} from "./server/rpc/client.ts";
export {
  isOmpReadyFrame,
  isOmpResponseFrame,
  makeOmpFrameDecoder,
  ompSupportsProtocolV2,
  OmpProtocolUnsupportedError,
  parseOmpRpcFrame,
} from "./server/rpc/frames.ts";
export {
  writeFakeOmp,
  type FakeOmpProgram,
  type FakeOmpResponseSpec,
  type FakeOmpTimedFrame,
  type FakeOmpTimedStderr,
} from "./server/rpc/fakeOmp.ts";
