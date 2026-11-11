import * as Schema from "effect/Schema";
import { tr } from "@t3tools/shared/i18n";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: tr("Could not load the secret request."),
  not_found: tr("This secret request no longer exists."),
  already_answered: tr("This secret request was already answered."),
  agent_stopped: tr("The agent that asked has stopped, so this secret can't be used."),
  store_failed: tr("Could not store the secret."),
  record_failed: tr("Saved the secret, but could not update the request."),
  invalid_ref: tr("That secretRef is not valid."),
  read_failed: tr("Could not read the secret."),
  ref_unavailable: tr(
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ),
  ref_expired: tr("That secretRef expired. Ask the user again with request_secret."),
  consume_failed: tr("Could not use that secretRef. Try again."),
  not_a_file_request: tr(
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
  ),
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
