import * as Effect from "effect/Effect";

import * as HostProcess from "@t3tools/shared/HostProcess";

// Intranet builds ship where the internet is unreachable, so the server must not reach out to
// one on its own. Upstream has no switch for the three behaviors below; each stays off unless
// it is opted into through the environment. See docs/operations/intranet-build.md.

/** `T3CODE_REMOTE_USAGE_RATES=1` restores the 24-hour cost rate table refresh. */
export const remoteUsageRatesEnabled = Effect.map(
  HostProcess.Environment,
  (environment) => environment.T3CODE_REMOTE_USAGE_RATES === "1",
);

/** `T3CODE_REMOTE_MODEL_MANIFEST=1` restores the hourly model manifest refresh. */
export const remoteModelManifestEnabled = Effect.map(
  HostProcess.Environment,
  (environment) => environment.T3CODE_REMOTE_MODEL_MANIFEST === "1",
);

/** Product analytics default; `T3CODE_TELEMETRY_ENABLED` still overrides it. */
export const telemetryDefaultEnabled = false;
