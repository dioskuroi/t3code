import { describe, expect, it } from "vite-plus/test";
import {
  appendPullRequestAgentPrompt,
  pullRequestAgentPrompt,
  pullRequestAgentThread,
} from "./pullRequestAgentTasks";
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

const GITHUB = sourceControlClients.get("github").changeRequest;

describe("PR agent tasks", () => {
  it("continues a single linked thread, but keeps an explicit new-thread choice separate", () => {
    const thread = {
      id: ThreadId.make("thread-one"),
      projectId: ProjectId.make("project-one"),
      title: "Existing work",
      archivedAt: null,
    };
    expect(pullRequestAgentThread([thread])).toBe(thread);
    expect(pullRequestAgentThread([thread], "new")).toBeUndefined();
    expect(pullRequestAgentThread([thread], "missing")).toBeUndefined();
    expect(pullRequestAgentThread([])).toBeUndefined();
    const archived = {
      ...thread,
      id: ThreadId.make("thread-two"),
      archivedAt: IsoDateTime.make("2026-10-09T10:00:00.000Z"),
    };
    expect(pullRequestAgentThread([thread, archived])).toBeUndefined();
    expect(pullRequestAgentThread([thread, archived], archived.id)).toBe(archived);
  });
  it("replaces the helper's own text when switching tasks, keeping user edits", () => {
    const first = appendPullRequestAgentPrompt("My question", "explain", GITHUB);
    const next = appendPullRequestAgentPrompt(
      first,
      "feedback",
      GITHUB,
      pullRequestAgentPrompt("explain", GITHUB),
    );
    expect(next).toBe(`My question\n\n${pullRequestAgentPrompt("feedback", GITHUB)}`);
    expect(
      appendPullRequestAgentPrompt(next, "ask", GITHUB, pullRequestAgentPrompt("feedback", GITHUB)),
    ).toBe("My question");
    const edited = `${first} with my own edit`;
    expect(
      appendPullRequestAgentPrompt(
        edited,
        "ask",
        GITHUB,
        pullRequestAgentPrompt("explain", GITHUB),
      ),
    ).toBe(edited);
  });
  it("names the change request with its host's term", () => {
    expect(pullRequestAgentPrompt("conflicts", GITHUB)).toContain(
      "解决此 pull request 与其基线分支的冲突。先确认此 Thread 位于 PR 的分支上；如果不是，先在它自己的工作树中准备好 PR。",
    );
    expect(
      pullRequestAgentPrompt("conflicts", sourceControlClients.get("gitlab").changeRequest),
    ).toContain(
      "解决此 merge request 与其基线分支的冲突。先确认此 Thread 位于 MR 的分支上；如果不是，先在它自己的工作树中准备好 MR。",
    );
  });
});
