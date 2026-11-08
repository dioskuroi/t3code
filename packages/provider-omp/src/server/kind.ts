// Owns the driver kind literal so driver.ts and adapter.ts can share it without an import cycle.
import { ProviderDriverKind } from "@t3tools/contracts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
