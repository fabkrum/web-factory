import type { ReviewReport } from "./review.ts";

/** A check with more failures than this shows the first ones and counts the rest. */
const SHOWN_PER_CHECK = 10;

/** The review as the Builder reads it in the terminal, grouped by Review area. */
export function formatReport(report: ReviewReport): string {
  const lines = [`Review of ${report.url}`, `Routes checked: ${report.routes.join(", ")}`, ""];
  for (const { area, checks, note } of report.areas) {
    lines.push(area);
    if (note) lines.push(`  ${note}`);
    else if (checks.length === 0) lines.push("  No Review checks in this area yet.");
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

/** One line of a check's detail, indented under it; a reason that spans lines (a test's output) stays indented. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
}
