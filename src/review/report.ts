import { ReviewError } from "./check.ts";
import type { ReviewReport } from "./review.ts";

/** A check with more failures than this shows the first ones and counts the rest. */
const SHOWN_PER_CHECK = 10;

/** The review as the Builder reads it in the terminal, grouped by Review area. */
export function formatReport(report: ReviewReport): string {
  const lines = [`Review of ${report.url}`, `Routes checked: ${report.routes.join(", ")}`, ""];
  for (const { area, checks } of report.areas) {
    lines.push(area);
    if (checks.length === 0) lines.push("  No Review checks in this area yet.");
    for (const check of checks) {
      if (check.skipped) {
        lines.push(`  NOT RUN  ${check.name}`, indent(check.skipped));
        continue;
      }
      lines.push(`  ${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
      for (const failure of check.failures.slice(0, SHOWN_PER_CHECK)) {
        lines.push(indent(failure.location), indent(failure.reason));
      }
      const hidden = check.failures.length - SHOWN_PER_CHECK;
      if (hidden > 0) lines.push(`        ...and ${hidden} more (factory review --json lists them all).`);
    }
    lines.push("");
  }
  const all = report.areas.flatMap((area) => area.checks);
  const failed = all.filter((check) => !check.passed).length;
  const notRun = all.filter((check) => check.skipped).length;
  lines.push(
    report.passed
      ? notRun > 0
        ? `The Site Passes every Review check that ran; ${notRun} ${notRun === 1 ? "was" : "were"} not run, as said above.`
        : "The Site Passes every Review check."
      : `The Site did not pass: ${failed} Review ${failed === 1 ? "check" : "checks"} failed. Fix what the reasons above say, then run the review again.`,
  );
  return `${lines.join("\n")}\n`;
}

/** What failed in a review, for a Build session or a park comment: each failing check by name, with where and why. */
export function formatFailures(report: ReviewReport): string {
  const lines: string[] = [];
  for (const check of report.areas.flatMap((area) => area.checks)) {
    if (check.passed) continue;
    lines.push(`The Review check "${check.name}" failed:`);
    for (const { location, reason } of check.failures.slice(0, SHOWN_PER_CHECK)) lines.push(`- ${location}: ${reason}`);
    const hidden = check.failures.length - SHOWN_PER_CHECK;
    if (hidden > 0) lines.push(`- ...and ${hidden} more.`);
  }
  return lines.join("\n");
}

/** One plain-language reason the review could not run, with no stack trace. */
export function couldNotRun(error: unknown): string {
  if (error instanceof ReviewError) return error.message;
  const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return `The review stopped before it could check your whole Site (${detail}). Check that your Site is still being served, then run the review again.`;
}

/** One line of a check's detail, indented under it; a reason that spans lines (a test's output) stays indented. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
}
