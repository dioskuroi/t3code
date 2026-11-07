// PROTOTYPE, throwaway (wayfinder #8): stub provider 无外部 CLI，零配置。
import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const StubSettings = makeProviderSettingsSchema({
  // 默认启用：不进 DEFAULT_DISABLED_PROVIDER_DRIVERS，冷启动即出现在 provider 列表。
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type StubSettings = typeof StubSettings.Type;
