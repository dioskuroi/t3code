// omp adapter, milestone M1 surface (spec §10). The turn lifeline (RPC client, event projection,
// session lifecycle per spec §5.2/5.4/5.5) lands in #14; every session entry point fails closed
// until then. Capabilities already carry the §7 terminal values so the presentation layer reads
// the real contract from day one.
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { OMP_PROVIDER } from "./kind.ts";

// Spec §7 (ADR-0004): subagents true/closable but not forkable/waitable, reasoning streams,
// everything unmapped stays unpresented (false).
const OmpProviderCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export const makeOmpAdapterV2 = (input: {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
}): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: input.instanceId,
  driver: OMP_PROVIDER,
  getCapabilities: () => Effect.succeed(OmpProviderCapabilities),
  planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
  openSession: (sessionInput) =>
    Effect.fail(
      new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: OMP_PROVIDER,
        providerSessionId: sessionInput.providerSessionId,
        cause: new Error("omp session lifecycle arrives with the M2 adapter (#14)."),
      }),
    ),
});
