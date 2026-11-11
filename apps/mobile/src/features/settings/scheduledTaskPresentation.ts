import { tr } from "@t3tools/shared/i18n";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 时间单位的显示名，供间隔与下次运行的格式化共用。 */
const UNIT_LABELS = {
  week: tr("week"),
  day: tr("day"),
  hour: tr("hour"),
  minute: tr("minute"),
  second: tr("second"),
  millisecond: tr("millisecond"),
} as const;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size)
      return tr("Every {unit}", { unit: UNIT_LABELS[unit] });
    parts.push(`${count} ${UNIT_LABELS[unit]}`);
    remaining %= size;
  }
  return tr("Every {parts}", { parts: parts.join(" ") });
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return tr("Next run unavailable");
  if (remaining <= 0) return tr("Next run due");

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return tr("Next run in less than a minute");
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return tr("Next run in {count} {unit}", { count, unit: UNIT_LABELS[unit] });
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return tr("Next run tomorrow at {time}", { time: time });
  if (days <= 7) {
    return tr("Next run next {weekday} at {time}", {
      weekday: next.toLocaleDateString([], { weekday: "long" }),
      time,
    });
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return tr("Next run {date} at {time}", { date: date, time: time });
}
