import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import { tr } from "@t3tools/shared/i18n";
import {
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ClockIcon,
  EyeIcon,
  LayersIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PenLineIcon,
  UserLockIcon,
} from "lucide-react";

import type { PullRequestFilterOption } from "./PullRequestListFilters";
import type { PullRequestListSort } from "./pullRequestListPreferences";
import { PullRequestGlyph } from "./pullRequestIcons";

export const INVOLVEMENT_TABS = [
  { value: "all", label: tr("All"), Icon: LayersIcon },
  { value: "reviewing", label: tr("Reviewing"), Icon: EyeIcon },
  { value: "authored", label: tr("Authored"), Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

export const STATE_TABS = [
  { value: "all", label: tr("All"), Icon: LayersIcon },
  { value: "open", label: tr("Open"), Icon: PullRequestGlyph.pullRequest },
  { value: "closed", label: tr("Closed"), Icon: PullRequestGlyph.closed },
  { value: "merged", label: tr("Merged"), Icon: PullRequestGlyph.merged },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

export const SORT_OPTIONS = [
  { value: "ready", label: tr("Merge readiness"), Icon: ListChecksIcon },
  { value: "blocked", label: tr("Blocked on me"), Icon: UserLockIcon },
  { value: "updated", label: tr("Recently updated"), Icon: ClockIcon },
  { value: "newest", label: tr("Newest shown"), Icon: CalendarArrowDownIcon },
  { value: "oldest", label: tr("Oldest shown"), Icon: CalendarArrowUpIcon },
  { value: "largest", label: tr("Largest shown"), Icon: Maximize2Icon },
  { value: "smallest", label: tr("Smallest shown"), Icon: Minimize2Icon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;
