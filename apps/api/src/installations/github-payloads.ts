/**
 * The slices of GitHub's webhook payloads this app reads. Deliberately partial: real
 * payloads carry dozens more fields, and typing only what is used keeps it obvious which
 * fields the code actually depends on.
 */

export interface GithubAccount {
  login: string;
  type: string; // "User" | "Organization"
}

export interface GithubInstallation {
  id: number;
  account: GithubAccount;
  suspended_at?: string | null;
}

/** Repositories as they appear in installation payloads — note: no `default_branch`. */
export interface GithubInstallationRepo {
  id: number;
  full_name: string;
  private: boolean;
}

/** `installation` event: created, deleted, suspend, unsuspend, new_permissions_accepted. */
export interface InstallationPayload {
  action: string;
  installation: GithubInstallation;
  repositories?: GithubInstallationRepo[];
}

/** `installation_repositories` event: added, removed. */
export interface InstallationRepositoriesPayload {
  action: 'added' | 'removed';
  installation: GithubInstallation;
  repositories_added: GithubInstallationRepo[];
  repositories_removed: GithubInstallationRepo[];
}
