/**
 * The boundary to the host the Builder chose at Kickoff. Every supported host
 * gives a Preview URL, so Approve always has something for the Builder to read.
 */
export interface Host {
  /** Deploys the branch, already pushed to the Site's remote, as a Preview and returns its URL. */
  deployPreview(preview: { siteDir: string; branch: string }): Promise<string>;
}
