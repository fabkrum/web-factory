/** The eight Stages of the Pipeline; each is one label on a GitHub issue. */
export const STAGES = ["request", "spec", "design", "build", "review", "approve", "publish", "measure"] as const;

export type Stage = (typeof STAGES)[number];

export function stageLabel(stage: Stage): string {
  return `stage:${stage}`;
}
