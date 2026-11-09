import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { OMP_PROVIDER } from "./kind.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "./status.ts";
import { makeOmpAdapterV2 } from "./adapter.ts";
import { OmpSettings } from "../settings.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// omp is a user-installed CLI; T3 Code never manages its installation or updates.
const ompMaintenance: ProviderMaintenanceCapabilities = {
  provider: OMP_PROVIDER,
  packageName: null,
  update: null,
};

export type OmpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ProviderHost.ProviderHost;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: OMP_PROVIDER,
  metadata: { displayName: "omp", supportsMultipleInstances: false },
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OMP_PROVIDER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: OMP_PROVIDER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance: () => Effect.succeed(ompMaintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        makePendingOmpProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkOmpProviderStatus(effectiveConfig, processEnvironment).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMP_PROVIDER,
            instanceId,
            detail: "Failed to build the omp provider snapshot.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter = yield* makeOmpAdapterV2({ instanceId });
    return {
      instanceId,
      driverKind: OMP_PROVIDER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: makeOmpTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
