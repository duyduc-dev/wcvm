export { cn } from "cn";

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** {amount, unit} steps, each dividing INTO the next - e.g. 60 seconds make a minute, 60 of those
 *  an hour. Walked in order until `duration` fits under one step's own amount. */
const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "seconds" },
  { amount: 60, unit: "minutes" },
  { amount: 24, unit: "hours" },
  { amount: 7, unit: "days" },
  { amount: 4.34524, unit: "weeks" },
  { amount: 12, unit: "months" },
  { amount: Number.POSITIVE_INFINITY, unit: "years" },
];

/** "2 hours ago", "in 3 days", "just now" - via the real, built-in `Intl.RelativeTimeFormat`
 *  rather than a date library, for something this small. */
export function formatRelativeTime(timestampMs: number): string {
  let duration = (timestampMs - Date.now()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return RELATIVE_TIME_FORMATTER.format(Math.round(duration), "years");
}
