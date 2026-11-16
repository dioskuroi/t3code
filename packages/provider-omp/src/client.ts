import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

// omp has no brand icon; a prompt-chevron mark keeps the tile neutral in light and dark palettes.
export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "omp",
  featured: true,
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 1200 1200",
    fill: { light: "#6D5BD0", dark: "#A99BE8" },
    paths: [
      {
        d: "M258 262 L646 600 L258 938 L258 772 L452 600 L258 428 Z",
      },
      {
        d: "M672 806 H966 V946 H672 Z",
      },
    ],
  },
});
