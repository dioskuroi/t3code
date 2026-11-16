import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { tr } from "@t3tools/shared/i18n";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { planThreadPullRequestMutation } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { AuthOrchestrationOperateScope, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";

import * as Dialog from "../../components/ui/Dialog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { MenuProps } from "../../components/ui/Menu.types";
import type { EnvironmentRuntimeState } from "../../state/remote-runtime-types";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type MenuAction = MenuProps["actions"][number];

export function useLinkedPullRequestActions(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
  readonly runtime: EnvironmentRuntimeState | null;
}) {
  const { thread, project, runtime } = input;
  const terminology = sourceControlClients.get(project?.repositoryIdentity?.provider).changeRequest;
  const capabilities = runtime?.serverConfig?.environment.capabilities;
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canEdit = canOperate && capabilities !== undefined;
  const canWatch = canOperate && capabilities?.threadPullRequestWatch === true;
  const canStartWatch =
    canWatch &&
    thread !== null &&
    thread.archivedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    thread.lineage.relationshipToParent !== "subagent";
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: false });

  const run = async (
    failureTitle: string,
    pending: Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    const result = await pending;
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, cause instanceof Error ? cause.message : tr("Try again."));
  };

  const setLinked = (
    reference: { host: string; repository: string; number: number; url: string },
    linked: boolean,
  ) => {
    if (thread === null) return;
    const mutation = planThreadPullRequestMutation({
      capabilities,
      threadId: thread.id,
      reference,
      linked,
    });
    if (mutation === null) return;
    const environmentId = thread.environmentId;
    void run(
      linked
        ? tr("Couldn't link this {kind}", { kind: terminology.singular })
        : tr("Couldn't unlink this {kind}", { kind: terminology.singular }),
      mutation.type === "thread.pull-request.link"
        ? link({ environmentId, input: mutation.input })
        : unlink({ environmentId, input: mutation.input }),
    );
  };

  const promptLink = () => {
    const { singular } = terminology;
    Dialog.prompt({
      title: tr("Link {singular}", { singular: singular }),
      message: tr("Paste a {singular} URL, or enter 123 / #123 for this thread's repository.", {
        singular: singular,
      }),
      placeholder: tr("{kind} URL or #42", { kind: capitalizeTerm(singular) }),
      initialValue: "",
      confirmText: tr("Link"),
      onConfirm: (reference) => {
        const resolved = resolveLinkPullRequestInput({
          reference,
          project: pullRequestLinkProject(project?.repositoryIdentity),
          hasProject: () => true,
        });
        if (resolved === null) {
          Dialog.alert(
            tr("Couldn't link this {singular}", { singular: singular }),
            tr("Use a {singular} URL, 123, or #123.", { singular: singular }),
          );
          return;
        }
        if ("error" in resolved) {
          Dialog.alert(tr("Couldn't link this {singular}", { singular: singular }), resolved.error);
          return;
        }
        setLinked(resolved.link, true);
      },
    });
  };

  const menuActions = (link: ThreadPullRequestLink): MenuAction[] => {
    const open = link.snapshot === null || link.snapshot.state === "open";
    const watching = link.watch !== undefined;
    return [
      { id: "copy", title: tr("Copy link"), image: "link" },
      { id: "browser", title: tr("Open in browser"), image: "safari" },
      ...((watching ? canWatch : canStartWatch) && open
        ? [
            {
              id: "watch",
              title: watching ? tr("Stop watching") : tr("Watch for changes"),
              image: watching ? "eye.slash" : "eye",
            },
          ]
        : []),
      ...(canEdit
        ? [
            {
              id: "unlink",
              title: link.source === "stack" ? tr("Dismiss from thread") : tr("Unlink from thread"),
              image: "xmark",
              attributes: { destructive: true },
            },
          ]
        : []),
    ];
  };

  const onMenuAction = (link: ThreadPullRequestLink, action: string) => {
    if (action === "copy") void Clipboard.setStringAsync(link.url);
    else if (action === "browser")
      void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
        if (!opened) {
          const { shortLabel, singular } = (
            sourceControlClients.findByChangeRequestUrl(link.url) ??
            sourceControlClients.get(undefined)
          ).changeRequest;
          Dialog.alert(
            tr("Unable to open {shortLabel}", { shortLabel: shortLabel }),
            tr("The {singular} could not be opened.", { singular: singular }),
          );
        }
      });
    else if (action === "watch" && thread !== null)
      void run(
        tr("Couldn't change watching"),
        watch({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: link.watch === undefined,
          },
        }),
      );
    else if (action === "unlink") setLinked(link, false);
  };

  return { canLink: canEdit, terminology, promptLink, menuActions, onMenuAction };
}

export type LinkedPullRequestActions = ReturnType<typeof useLinkedPullRequestActions>;
