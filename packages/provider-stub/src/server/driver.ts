// PROTOTYPE, throwaway (wayfinder #8): 最小 stub provider driver。
// 无外部 CLI、无认证、无维护设施：snapshot 静态可用，adapter 伪造事件流。
import {
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { StubSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import { makeStubAdapterV2 } from "./adapter.ts";
import { STUB_PROVIDER } from "./kind.ts";

const STUB_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "stub/echo", name: "Stub Echo", isCustom: false, isDefault: true, capabilities: null },
  { slug: "stub/slow-echo", name: "Stub Slow Echo", isCustom: false, capabilities: null },
];

const maintenance: ProviderMaintenanceCapabilities = {
  provider: STUB_PROVIDER,
  packageName: null,
  update: null,
};

const decodeStubSettings = Schema.decodeSync(StubSettings);

const buildStubSnapshot = (input: {
  readonly instanceId: ServerProvider["instanceId"];
  readonly enabled: boolean;
  readonly checkedAt: string;
}): ServerProvider => {
  return {
    instanceId: input.instanceId,
    driver: STUB_PROVIDER,
    enabled: input.enabled,
    installed: true,
    version: "0.0.0-proto",
    status: input.enabled ? "ready" : "disabled",
    auth: { status: "unknown" },
    checkedAt: input.checkedAt,
    message: "PROTOTYPE stub provider (wayfinder #8). Not a real agent.",
    models: [...STUB_MODELS],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: false, canInstall: false },
  };
};

const makeStaticSnapshot = (snapshot: ServerProvider): ManagedServerProvider => ({
  resolveMaintenance: () => Effect.succeed(maintenance),
  getSnapshot: Effect.succeed(snapshot),
  refresh: Effect.succeed(snapshot),
  streamChanges: Stream.succeed(snapshot),
  applyUsageLimits: () => Effect.void,
});

function stubTextError(operation: string) {
  return new TextGenerationError({
    operation,
    detail: "Stub provider does not generate text.",
  });
}

const stubTextGeneration: ProviderInstance["textGeneration"] = {
  generateCommitMessage: () => Effect.fail(stubTextError("generateCommitMessage")),
  generatePrContent: () => Effect.fail(stubTextError("generatePrContent")),
  generateBranchName: () => Effect.fail(stubTextError("generateBranchName")),
  generateThreadTitle: () => Effect.fail(stubTextError("generateThreadTitle")),
  generateReviewGuide: () => Effect.fail(stubTextError("generateReviewGuide")),
};

export type StubDriverEnv = never;

export const StubDriver: ProviderDriver<StubSettings, StubDriverEnv> = {
  driverKind: STUB_PROVIDER,
  metadata: {
    displayName: "Stub",
    supportsMultipleInstances: false,
  },
  configSchema: StubSettings,
  defaultConfig: (): StubSettings => decodeStubSettings({}),
  create: Effect.fn("StubDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
  }) {
    const orchestrationAdapter = makeStubAdapterV2({ instanceId });
    return {
      instanceId,
      driverKind: STUB_PROVIDER,
      continuationIdentity: defaultProviderContinuationIdentity({
        driverKind: STUB_PROVIDER,
        instanceId,
      }),
      displayName,
      accentColor,
      enabled,
      snapshot: makeStaticSnapshot(
        buildStubSnapshot({
          instanceId,
          enabled,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      ),
      orchestrationAdapter,
      textGeneration: stubTextGeneration,
    } satisfies ProviderInstance;
  }),
};
