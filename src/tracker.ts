/** A Request, Spec or Ticket as the tracker holds it. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

/** The boundary to wherever the Site's issues live (GitHub, through its CLI). */
export interface Tracker {
  /** The Tickets of a Spec: its sub-issues, open or closed. */
  ticketsOf(spec: number): Promise<Issue[]>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}
