import { describe, expect, it } from "vite-plus/test";

import { tr } from "./i18n.ts";
import {
  decodeThirdPartyLicenseManifest,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "./thirdPartyLicenses.js";

const ENTRIES: ReadonlyArray<ThirdPartyLicenseEntry> = [
  {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "React license",
    sourceUrl: "https://react.dev",
    version: "19.2.6",
  },
  {
    bundles: ["assets", "mobile"],
    kind: "custom",
    license: "CC-BY-4.0",
    name: "sample-icons",
    noticeText: "Icon notice",
    sourceUrl: null,
    version: null,
  },
];

describe("third-party license manifests", () => {
  it("rejects unsafe source links", () => {
    expect(() =>
      decodeThirdPartyLicenseManifest({
        schemaVersion: 1,
        entries: [{ ...ENTRIES[0]!, sourceUrl: "javascript:alert(1)" }],
      }),
    ).toThrow(tr("License entry {index} has an invalid shape.", { index: 1 }));
  });

  it("uses distinct navigation keys when names and versions contain delimiters", () => {
    const first = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a:1", version: null });
    const second = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a", version: "1:custom" });

    expect(first).not.toBe(second);
  });
});
