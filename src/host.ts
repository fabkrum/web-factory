/**
 * The boundary to the host the Builder chose at Kickoff. Every supported host
 * gives a Preview URL, so Approve always has something for the Builder to read.
 */
export interface Host {
  /**
   * Finishes the host's setup during Kickoff, once the Builder has done their part. Refuses
   * with a `HostError` naming what is still missing; running it again changes nothing.
   */
  connect(site: { siteDir: string; baseBranch: string }): Promise<void>;
  /**
   * Deploys the branch as a Preview and returns its URL. The live Site does not change, and
   * deploying the same branch again replaces its Preview at the same URL.
   */
  deployPreview(preview: { siteDir: string; branch: string }): Promise<string>;
  /** Publishes the Site as it stands in `siteDir` and returns the live URL. */
  publishLive(site: { siteDir: string }): Promise<string>;
}

/** A host step that failed for a reason the Builder can read; the message is printed as it is. */
export class HostError extends Error {}

/**
 * Whether the host named at Kickoff is the one the Firebase adapter serves. Firebase App
 * Hosting is not: it rolls out one live branch and has no preview channels.
 */
export function isFirebaseHosting(host: string): boolean {
  return /firebase/i.test(host) && !/app\s*hosting/i.test(host);
}
