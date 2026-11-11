import { describe, expect, it } from "vite-plus/test";
import { tr } from "@t3tools/shared/i18n";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  nextWorkflowSelection,
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
  workflowMemberDetail,
  workflowMemberMetadata,
  workflowRail,
} from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: tr("Audit the timestamps"),
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: tr("Reading files"),
      result: "stale result",
    });

    expect(row.detail).toBe(tr("Reading files"));
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: tr("Reading files"),
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe(tr("Found two problems"));
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe(tr("Completed"));
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: tr("Timed out"),
    });

    expect(row.detail).toBe(tr("Timed out"));
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({
      ...base,
      title: tr("Subagent: /root/my_worker"),
    });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe(tr("My Worker"));
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe(tr("Working"));
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe(tr("Failed"));
  });
});

type WorkflowAgent = OrchestrationV2SubagentWorkflow["agents"][number];

const workflowRailOf = (
  agents: ReadonlyArray<WorkflowAgent>,
  status: "running" | "completed" = "running",
) =>
  workflowRail(
    deriveWorkflowGroups(
      projectedSubagentsToRuntime([
        {
          id: "workflow",
          title: tr("Mobile Stop review"),
          prompt: "",
          model: null,
          status,
          result: null,
          startedAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-08-01T10:00:05.000Z"),
          workflow: {
            phases: [
              { index: 0, title: tr("Inspect") },
              { index: 1, title: tr("Verify") },
              { index: 2, title: tr("Report") },
            ],
            agents,
          },
        },
      ]),
    )[0]!,
  );

const agent = (
  index: number,
  phaseIndex: number | undefined,
  state: WorkflowAgent["state"],
  overrides: Partial<WorkflowAgent> = {},
): WorkflowAgent => ({
  index,
  label: `agent ${index}`,
  state,
  ...(phaseIndex === undefined ? {} : { phaseIndex }),
  ...overrides,
});

describe("workflowRail", () => {
  it("keeps declared phases without agents and gives unphased agents a stop", () => {
    const rail = workflowRailOf([
      agent(1, 0, "completed"),
      agent(2, 1, "running"),
      agent(3, undefined, "queued"),
    ]);

    expect(rail.map((item) => [item.title, item.tone, item.members.length])).toEqual([
      [tr("Inspect"), "completed", 1],
      [tr("Verify"), "working", 1],
      [tr("Report"), "queued", 0],
      [tr("Other"), "queued", 1],
    ]);
  });

  it("counts only completed agents toward a failed phase's progress", () => {
    const [phase] = workflowRailOf([agent(1, 0, "failed"), agent(2, 0, "completed")], "completed");

    expect([phase!.tone, phase!.completedCount, phase!.members.length]).toEqual(["failed", 1, 2]);
  });
});

describe("nextWorkflowSelection", () => {
  const running = workflowRailOf([agent(1, 0, "completed"), agent(2, 1, "running")]);

  it("opens the running phase from the collapsed title, then collapses", () => {
    expect(nextWorkflowSelection(running, null)).toBe("1");
    expect(nextWorkflowSelection(running, "1")).toBeNull();
  });

  it("prefers the failed phase, then the latest phase with agents", () => {
    const failed = workflowRailOf([agent(1, 0, "failed"), agent(2, 1, "completed")], "completed");
    const done = workflowRailOf([agent(1, 0, "completed"), agent(2, 1, "completed")], "completed");

    expect(nextWorkflowSelection(failed, null)).toBe("0");
    expect(nextWorkflowSelection(done, null)).toBe("1");
    expect(nextWorkflowSelection(workflowRailOf([]), null)).toBeNull();
  });

  it("keeps one phase open: another replaces it and the open one collapses the card", () => {
    expect(nextWorkflowSelection(running, null, "0")).toBe("0");
    expect(nextWorkflowSelection(running, "1", "0")).toBe("0");
    expect(nextWorkflowSelection(running, "0", "0")).toBeNull();
  });
});

describe("workflow member rows", () => {
  it("keeps reported model, effort, and speed once an agent completes", () => {
    const [completed] = workflowRailOf(
      [
        agent(1, 0, "completed", {
          model: "claude-opus-5-5",
          effort: "high",
          speed: "fast",
          result: tr("Checked controls"),
        }),
      ],
      "completed",
    )[0]!.members;

    expect(workflowMemberMetadata(completed!, undefined)).toEqual({
      model: tr("Claude Opus 5.5"),
      effort: tr("High"),
      speed: "Fast",
      fast: true,
    });
    expect(workflowMemberDetail(completed!)).toEqual({
      detail: tr("Checked controls"),
      error: null,
    });
  });

  it("reports nothing the provider did not send", () => {
    expect(workflowMemberMetadata({ model: null, effort: null }, undefined)).toEqual({
      model: null,
      effort: null,
      speed: null,
      fast: false,
    });
  });

  it("labels effort from the catalog model a reported alias resolves to", () => {
    expect(
      workflowMemberMetadata(
        { model: "opus", effort: "xhigh" },
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              slug: "claude-opus-5-5",
              name: tr("Claude Opus 5.5"),
              shortName: tr("Opus 5.5"),
              aliases: ["opus"],
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: tr("Reasoning"),
                    type: "select",
                    options: [{ id: "xhigh", label: tr("Extra High") }],
                  },
                ],
              },
            },
          ],
        },
      ),
    ).toMatchObject({ model: tr("Opus 5.5"), effort: tr("Extra High") });
  });

  it("shows a failed agent's error under its prompt", () => {
    const [failed] = workflowRailOf([
      agent(1, 0, "failed", { prompt: tr("Update session store"), result: tr("Type error") }),
    ])[0]!.members;

    expect(workflowMemberDetail(failed!)).toEqual({
      detail: tr("Update session store"),
      error: tr("Type error"),
    });
  });
});

const stopAgent = {
  id: NodeId.make("agent"),
  threadId: ThreadId.make("parent"),
  childThreadId: ThreadId.make("child"),
  status: "running" as const,
  origin: "app_owned" as const,
  driver: ProviderDriverKind.make("codex"),
  runId: RunId.make("run"),
  nativeTaskRef: null,
};

describe("resolveSubagentStopTarget", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "stops the parent task and child of an app-owned %s agent",
    (status) => {
      expect(resolveSubagentStopTarget({ ...stopAgent, status })).toEqual({
        kind: "subagent",
        input: { threadId: stopAgent.threadId, subagentId: stopAgent.id },
      });
      expect(resolveSubagentStopTarget({ ...stopAgent, status, childThreadId: null })).toBeNull();
    },
  );

  it.each(["idle", "completed", "failed", "cancelled", "interrupted"] as const)(
    "offers no Stop for a %s agent",
    (status) => {
      expect(resolveSubagentStopTarget({ ...stopAgent, status })).toBeNull();
    },
  );

  const native = {
    ...stopAgent,
    origin: "provider_native" as const,
    driver: ProviderDriverKind.make("claudeAgent"),
    childThreadId: null,
    nativeTaskRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      strength: "strong" as const,
      nativeId: "native-task",
    },
  };

  it("targets a supported native task without interrupting its parent run", () => {
    expect(resolveSubagentStopTarget(native)).toEqual({
      kind: "subagent",
      input: { threadId: native.threadId, subagentId: native.id },
    });
  });

  it("hides native Stop when the task cannot be identified or stopped", () => {
    expect(resolveSubagentStopTarget({ ...native, nativeTaskRef: null })).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        nativeTaskRef: { ...native.nativeTaskRef, strength: "weak" },
      }),
    ).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        nativeTaskRef: { ...native.nativeTaskRef, nativeId: null },
      }),
    ).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, runId: null })).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, status: "completed" })).toBeNull();
    expect(
      resolveSubagentStopTarget({ ...native, driver: ProviderDriverKind.make("codex") }),
    ).toBeNull();
  });

  it("stops the whole workflow through its own command", () => {
    const workflow = { name: tr("Review"), phases: [], agents: [] };
    expect(resolveSubagentStopTarget({ ...native, workflow })).toEqual({
      kind: "workflow",
      input: { threadId: native.threadId, subagentId: native.id },
    });
    expect(resolveSubagentStopTarget({ ...native, workflow, status: "waiting" })).toBeNull();
    expect(resolveSubagentStopTarget({ ...stopAgent, workflow })).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, workflow, nativeTaskRef: null })).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        workflow,
        nativeTaskRef: { ...native.nativeTaskRef, nativeId: "" },
      }),
    ).toBeNull();
  });
});
