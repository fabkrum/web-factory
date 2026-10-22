/** The eight Stages of the Pipeline; each is one label on a GitHub issue. */
export const STAGES = ["request", "spec", "design", "build", "review", "approve", "publish", "measure"] as const;

export type Stage = (typeof STAGES)[number];

/** The Stages that wait for the Builder; the others run by themselves. */
export const DECISION_STAGES: readonly Stage[] = ["request", "spec", "design", "approve"];

export function stageLabel(stage: Stage): string {
  return `stage:${stage}`;
}

export function isStageLabel(label: string): boolean {
  return STAGES.some((stage) => stageLabel(stage) === label.toLowerCase());
}
