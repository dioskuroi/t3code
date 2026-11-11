import { describe, expect, it } from "@effect/vitest";
import { tr } from "@t3tools/shared/i18n";

import { projectThreadContentPresentation } from "./threadContentPresentation";

describe("thread content presentation", () => {
  it("renders cached detail while its environment reconnects", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: null,
        detailDeleted: false,
        connectionState: "reconnecting",
      }),
    ).toEqual({ kind: "ready" });
  });

  it("explains uncached detail while disconnected instead of loading forever", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: false,
        connectionState: "error",
      }),
    ).toEqual({
      kind: "unavailable",
      title: tr("Messages not cached"),
      detail: tr("Reconnect this environment to load the conversation."),
    });
  });
});
