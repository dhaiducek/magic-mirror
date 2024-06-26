import { Octokit } from "@octokit/rest";
import { Database, PendingPR, PRAction } from "./db";
import yaml from "js-yaml";

/**
 * Create a GitHub issue indicating that sync from upstream failed.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} org the GitHub organization where the issue is to be created.
 * @param {string} repo the GitHub repository where the issue is to be created.
 * @param {string} upstreamOrg the upstream GitHub organization that sync was from.
 * @param {string} branch the forked repository's branch that had the failed sync.
 * @param {Array<number>} upstreamPRIDs the upstream pull-request IDs that were part of the failed sync.
 * @param {string} reason the reason that the sync failed.
 * @param {number} prID an optional pull-request ID of the forked repository's sync PR. This isn't set if the PR
 *   couldn't be created due to something like a merge conflict.
 * @param {Array<string>} assignees user to assign to the issue.
 * @param {Array<string>} patchCmd git commands to recreate the PR
 * @param {string} err the error when the sync was attempted.
 * @return {Promise<number>} a Promise that resolves to the created GitHub issue ID.
 */
export async function createFailureIssue(
  client: Octokit,
  org: string,
  repo: string,
  upstreamOrg: string,
  branch: string,
  upstreamPRIDs: Array<number>,
  reason: string,
  prID?: number,
  assignees?: Array<string>,
  patchCmd?: Array<string>,
  err?: any,
): Promise<number> {
  const title = `😿 Failed to sync the upstream PRs: #${upstreamPRIDs.join(", #")}`;
  const prPrefix = `\n* ${upstreamOrg}/${repo}#`;
  let body =
    `🪞 Magic Mirror 🪞 failed to sync the following upstream pull-requests because ${reason}:` +
    `${prPrefix}${upstreamPRIDs.join(prPrefix)}\n\n`;

  if (prID) {
    body += `The pull-request (#${prID}) can be reviewed for more information.\n\n`;
  }

  body +=
    `Syncing is paused for the branch ${branch} on ${org}/${repo} until the issue is manually resolved and this ` +
    "issue is closed.\n";

  if (err) {
    body += "\nSyncing error:\n```\n" + err + "\n```\n";
  }

  if (patchCmd) {
    body += "\nCommands to recreate the issue:\n" + "\n```\n" + patchCmd.join("\n") + "\n```\n";
  }

  body += "\n![sad Yoda](https://media.giphy.com/media/3o7qDK5J5Uerg3atJ6/giphy.gif)";

  const resp = await client.issues.create({ owner: org, repo: repo, title: title, body: body, assignees: assignees });
  return resp.data.number;
}

/**
 * Comment on a GitHub issue (or pull request).
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} org the GitHub organization where the issue is to add a comment.
 * @param {string} repo the GitHub repository where the issue is to add a comment.
 * @param {number} id the issue ID.
 * @param {string} message the content of the comment.
 * @return {Promise<any>}
 */
export async function addComment(
  client: Octokit,
  org: string,
  repo: string,
  id: number,
  message: string,
): Promise<any> {
  try {
    await client.issues.createComment({ owner: org, repo: repo, issue_number: id, body: message });

    return;
  } catch (err) {
    return err;
  }
}

/**
 * Update a GitHub pull request.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} org the GitHub organization where the issue is to add a comment.
 * @param {string} repo the GitHub repository where the issue is to add a comment.
 * @param {number} id the pull-request ID.
 * @param {Array<string>} assignees the assignees for the PR.
 * @param {string} message the content to append to the PR description.
 * @return {Promise<any>} a Promise that resolves to errors whether the PR was successfully updated.
 */
export async function updatePR(
  client: Octokit,
  org: string,
  repo: string,
  id: number,
  assignees: Array<string>,
  message: string,
): Promise<any> {
  let body;
  try {
    const resp = await client.pulls.get({ owner: org, repo: repo, pull_number: id });

    body = resp.data.body;
    if (body == null) {
      return;
    }

    // Use the previous assignees if it was already specified
    if (resp.data.assignees && resp.data.assignees.length > 0) {
      assignees = resp.data.assignees?.map((assignee) => assignee.login) || [];
    }
  } catch (err) {
    return err;
  }

  body += `\n\n${message}`;

  try {
    await client.pulls.update({ owner: org, repo: repo, pull_number: id, body: body, assignees: assignees });

    return;
  } catch (err) {
    return err;
  }
}

/**
 * Get the required check names (statuses and check runs) for the branch.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} organization the GitHub organization of the repository to check.
 * @param {string} repoName the GitHub repository name of the repository to check.
 * @param {string} branchName the GitHub branch name to check.
 * @return {Promise<Set<string>>} a Promise that resolves to a set of required check names.
 */
export async function getRequiredChecks(
  client: Octokit,
  organization: string,
  repoName: string,
  branchName: string,
): Promise<Set<string>> {
  const branch = await client.repos.getBranch({ owner: organization, repo: repoName, branch: branchName });
  if (!branch.data.protection.enabled || !branch.data.protection.required_status_checks) {
    return new Set<string>();
  }

  return new Set(branch.data.protection.required_status_checks.contexts);
}

/**
 * Merge the GitHub pull-request with the rebase merge method.
 *
 * If the PR cannot be merged, a GitHub issue is created to notify of the failure.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {Database} db the Database instance to use to update the PendingPR object if the PR merge fails.
 * @param {PendingPR} pendingPR the PendingPR object that represents the PR to merge.
 * @param {string} head the Git commit hash of the head of the PR to merge. If the PR head has changed while the PR was
 *   being examined by Magic Mirror, the PR won't be merged.
 * @return {Promise<boolean>} a Promise that resolves to a boolean indicating if the PR was successfully merged.
 */
export async function mergePR(client: Octokit, db: Database, pendingPR: PendingPR, head: string): Promise<boolean> {
  try {
    await client.pulls.merge({
      owner: pendingPR.repo.organization,
      repo: pendingPR.repo.name,
      pull_number: pendingPR.prID as number,
      merge_method: "rebase",
      sha: head,
    });

    return true;
  } catch (err) {
    const issueID = await createFailureIssue(
      client,
      pendingPR.repo.organization,
      pendingPR.repo.name,
      pendingPR.upstreamRepo.organization,
      pendingPR.branch,
      pendingPR.upstreamPRIDs,
      `the pull-request (#${pendingPR.prID}) couldn't be merged: ${err}`,
      pendingPR.prID as number,
      pendingPR.upstreamAuthors,
    );

    pendingPR.githubIssue = issueID;
    pendingPR.action = PRAction.Blocked;
    await db.setPendingPR(pendingPR);

    return false;
  }
}

/**
 * Returns list of approvers from the OWNERS file at the base of the repo.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} organization the GitHub organization of the repository to check.
 * @param {string} repoName the GitHub repository name of the repository to check.
 * @param {string} branchName the GitHub branch name to check.
 * @param {Array<string>} prAuthor the author of the pull request.
 * @return {Promise<boolean>} a Promise that resolves to whether the given author is also an owner.
 */
export async function getOwners(
  client: Octokit,
  organization: string,
  repoName: string,
  branchName: string,
): Promise<string[]> {
  try {
    const ownersFileObject = await client.repos.getContent({
      owner: organization,
      repo: repoName,
      path: "OWNERS",
      ref: branchName,
      mediaType: { format: "application/vnd.github+json" },
    });

    if (
      !Array.isArray(ownersFileObject) &&
      "content" in ownersFileObject &&
      typeof ownersFileObject.content == "string"
    ) {
      const rawYaml = Buffer.from(ownersFileObject.content, "base64").toString("utf-8");
      const ownersObj = yaml.load(rawYaml);
      if (typeof ownersObj == "object" && ownersObj && "approvers" in ownersObj && Array.isArray(ownersObj.approvers)) {
        return ownersObj.approvers;
      }
    }
  } catch (err) {
    return Promise.reject(new Error(`failed to retrieve OWNERS file: ${err}`));
  }

  return [];
}
