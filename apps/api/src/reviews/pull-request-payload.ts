/** The slice of GitHub's `pull_request` webhook payload this app reads. */
export interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    draft: boolean;
    head: { sha: string };
    base: { sha: string };
  };
  repository: {
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
  };
  installation?: { id: number };
}
