import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEnvironmentIconPickerLock } from "./EnvironmentIconPicker";

const config = { environment: { capabilities: {} } } as unknown as ServerConfig;

describe("resolveEnvironmentIconPickerLock", () => {
  it("waits for a settings grant before allowing changes", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config, operateAccess: "pending" }),
    ).toMatch(/无法更改/);
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config, operateAccess: "granted" }),
    ).toBeNull();
  });
});
