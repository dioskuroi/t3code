// Intranet builds ship where the internet is unreachable, so the server must not reach out to
// one on its own. Upstream has no switch for the three behaviors below; each stays off unless
// it is opted into through the environment. Login, updates and T3 Connect need no entry:
// upstream's build-time configuration turns them off (docs/fork/intranet.md).

/** `T3CODE_REMOTE_USAGE_RATES=1` restores the 24-hour cost rate table refresh. */
export const remoteUsageRatesEnabled = (): boolean => process.env.T3CODE_REMOTE_USAGE_RATES === "1";

/** `T3CODE_REMOTE_MODEL_MANIFEST=1` restores the hourly model manifest refresh. */
export const remoteModelManifestEnabled = (): boolean =>
  process.env.T3CODE_REMOTE_MODEL_MANIFEST === "1";

/** Product analytics default; `T3CODE_TELEMETRY_ENABLED` still overrides it. */
export const telemetryDefaultEnabled = false;
