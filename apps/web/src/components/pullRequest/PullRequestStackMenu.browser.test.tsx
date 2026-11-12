import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ detail: "" }));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { PullRequestOperationError } = await import("@t3tools/contracts");
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (() => async () =>
      AsyncResult.failure(
        Cause.fail(new PullRequestOperationError({ operation: "runAction", detail: state.detail })),
      )) as never,
  };
});

import "~/index.css";
import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { PullRequestStackMenu } from "./PullRequestStackMenu";

function setup(detail: string) {
  state.detail = detail;
}

const HEAD_MOVED = "The stack head moved. Refresh the stack before trying again.";

// readableFailure 从结构化字段取 detail（前缀由 UI 标题承担），与本地化前的原始行为一致。
const operationFailure = (detail: string) => detail;

it.each([
  { label: "Merge stack", detail: HEAD_MOVED, description: operationFailure(HEAD_MOVED) },
  { label: "Rebase stack", detail: HEAD_MOVED, description: operationFailure(HEAD_MOVED) },
  {
    label: "Rebase stack",
    detail: "GitHub CLI command failed.",
    // 该 detail 命中 TOOL_NOISE，回落到 rebase 拒绝 hint。
    description: tr(
      "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.",
    ),
  },
])("$label refused with $detail shows $description", async (row) => {
  setup(row.detail);
  await using screen = await render(
    <ToastProvider timeout={0}>
      <PullRequestStackMenu
        environmentId={EnvironmentId.make("environment")}
        reference={{
          projectId: ProjectId.make("project"),
          repository: "owner/repository",
          number: 2,
        }}
        hostLabel="GitHub"
        terminology={sourceControlClients.get("github").changeRequest}
        stack={{
          id: "stack",
          number: 1,
          url: "https://github.com/owner/repository/stack/1",
          base: "main",
          layers: [{ number: 2, headBranch: "feature", headSha: "abc123", state: "open" }],
        }}
        canMerge
        stale={false}
        canRebase
        mergeMethod="squash"
        onActed={() => {}}
      />
    </ToastProvider>,
  );
  if (row.label === "Rebase stack") {
    await screen
      .getByRole("button", {
        name: tr("Stack {number}, layer {position} of {total}", {
          number: 1,
          position: 1,
          total: 1,
        }),
      })
      .click();
    await page.getByRole("menuitem", { name: tr(row.label) }).click();
  } else {
    await screen.getByRole("button", { name: tr(row.label), exact: true }).click();
  }
  await page
    .getByRole("dialog")
    .getByRole("button", { name: tr(row.label), exact: true })
    .click();
  await expect.element(page.getByText(row.description, { exact: true })).toBeInTheDocument();
});
