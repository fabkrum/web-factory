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
      lines.push(`  ${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
      for (const failure of check.failures.slice(0, SHOWN_PER_CHECK)) {
        lines.push(`        ${failure.location}`, `        ${failure.reason}`);
      }
      const hidden = check.failures.length - SHOWN_PER_CHECK;
      if (hidden > 0) lines.push(`        ...and ${hidden} more (factory review --json lists them all).`);
    }
    lines.push("");
  }
  const failed = report.areas.flatMap((area) => area.checks).filter((check) => !check.passed).length;
  lines.push(
    report.passed
      ? "The Site Passes every Review check."
      : `The Site did not pass: ${failed} Review ${failed === 1 ? "check" : "checks"} failed. Fix what the reasons above say, then run the review again.`,
  );
  return `${lines.join("\n")}\n`;
}
