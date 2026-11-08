// omp is zero-config for MVP (spec §5.1): credentials come from the environment or omp's own
// models.yml, and the binary is discovered on PATH. Only the lifecycle `enabled` flag exists.
import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OmpSettings = makeProviderSettingsSchema({
  // Default enabled: omp is not in DEFAULT_DISABLED_PROVIDER_DRIVERS, so the default instance
  // shows up in the provider list on a cold start.
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type OmpSettings = typeof OmpSettings.Type;
