const core = require('@actions/core');
const github = require('@actions/github');

const DEPENDABOT_LOGINS = new Set(['dependabot[bot]', 'dependabot-preview[bot]']);

async function listOpenDependabotPRs(octokit, owner, repo) {
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return prs.filter((pr) => DEPENDABOT_LOGINS.has(pr.user?.login));
}

async function getReviews(octokit, owner, repo, pull_number) {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return reviews;
}

function countApprovals(reviews) {
  const latestByUser = new Map();
  for (const review of reviews) {
    if (!review.user?.login) continue;
    latestByUser.set(review.user.login, review.state);
  }
  let approvals = 0;
  for (const state of latestByUser.values()) {
    if (state === 'APPROVED') approvals += 1;
  }
  return approvals;
}

async function checksArePassing(octokit, owner, repo, ref) {
  const [combined, checkRuns] = await Promise.all([
    octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
    octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 }),
  ]);

  const statusOk = combined.data.state === 'success';
  const runs = checkRuns.data.check_runs || [];
  const runsOk = runs.every((run) => run.conclusion === 'success' || run.conclusion === 'skipped');
  return statusOk && runsOk;
}

async function processPullRequest(octokit, owner, repo, pr, options) {
  const { minApprovals } = options;

  if (!DEPENDABOT_LOGINS.has(pr.user?.login)) {
    core.info(`Skipping PR #${pr.number}: not Dependabot`);
    return;
  }

  if (pr.draft) {
    core.info(`Skipping PR #${pr.number}: draft`);
    return;
  }

  const reviews = await getReviews(octokit, owner, repo, pr.number);
  const approvals = countApprovals(reviews);
  if (approvals < minApprovals) {
    core.info(`Skipping PR #${pr.number}: approvals ${approvals} < ${minApprovals}`);
    return;
  }

  const checksPass = await checksArePassing(octokit, owner, repo, pr.head.sha);
  if (!checksPass) {
    core.info(`Skipping PR #${pr.number}: checks not passing`);
    return;
  }

  const prDetails = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (!prDetails.data.mergeable) {
    core.info(`Skipping PR #${pr.number}: not mergeable`);
    return;
  }

  core.info(`Merging PR #${pr.number} with squash`);
  await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pr.number,
    merge_method: 'squash',
  });
}

async function getPRFromCheckSuite(octokit, owner, repo, headSha) {
  // Find the open PR associated with this check suite's head SHA
  const prs = await listOpenDependabotPRs(octokit, owner, repo);
  return prs.find((pr) => pr.head.sha === headSha);
}

async function run() {
  try {
    const token = core.getInput('github_token', { required: true });
    const minApprovalsInput = core.getInput('min_approvals');
    const minApprovals = minApprovalsInput ? parseInt(minApprovalsInput, 10) : 1;

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    if (github.context.eventName === 'pull_request') {
      const pr = github.context.payload.pull_request;
      if (!pr) {
        core.info('No pull request in context.');
        return;
      }
      await processPullRequest(octokit, owner, repo, pr, { minApprovals });
      return;
    }

    // Handle review submitted event (approval)
    if (github.context.eventName === 'pull_request_review') {
      const pr = github.context.payload.pull_request;
      const review = github.context.payload.review;
      if (!pr) {
        core.info('No pull request in context.');
        return;
      }
      core.info(`Review submitted on PR #${pr.number}: ${review?.state || 'unknown'}`);
      await processPullRequest(octokit, owner, repo, pr, { minApprovals });
      return;
    }

    // Handle check suite completed event
    if (github.context.eventName === 'check_suite') {
      const checkSuite = github.context.payload.check_suite;
      if (checkSuite?.conclusion !== 'success') {
        core.info(`Check suite conclusion: ${checkSuite?.conclusion}, skipping`);
        return;
      }
      const headSha = checkSuite.head_sha;
      core.info(`Check suite completed successfully for SHA: ${headSha}`);

      const pr = await getPRFromCheckSuite(octokit, owner, repo, headSha);
      if (!pr) {
        core.info(`No open Dependabot PR found for SHA: ${headSha}`);
        return;
      }
      core.info(`Found matching PR #${pr.number}`);
      await processPullRequest(octokit, owner, repo, pr, { minApprovals });
      return;
    }

    if (['schedule', 'workflow_dispatch'].includes(github.context.eventName)) {
      const prs = await listOpenDependabotPRs(octokit, owner, repo);
      for (const pr of prs) {
        await processPullRequest(octokit, owner, repo, pr, { minApprovals });
      }
      return;
    }

    core.info(`Event '${github.context.eventName}' not supported.`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
