/** The slice of GitHub's `pull_request_review_thread` webhook payload this app reads. */
export interface ReviewThreadPayload {
  action: string;
  thread: {
    /** The thread's comments; the first is the one a Finding stores the ID of. */
    comments: { id: number }[];
  };
}
