// PROTOTYPE, throwaway (wayfinder #8): stub provider 的客户端呈现。
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { StubSettings } from "./settings.ts";

// 一个空心的方块图标：stub 没有品牌。
const TILE = "M120 120H1080V1080H120Z";

export const stubClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("stub"),
  label: "Stub",
  featured: false,
  badgeLabel: "Prototype",
  settingsSchema: StubSettings,
  icon: {
    viewBox: "0 0 1200 1200",
    fill: { light: "#6E7B8B", dark: "#9AA7B8" },
    paths: [{ d: TILE }],
  },
});
