const core = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

const DEPENDABOT_LOGINS = new Set(['dependabot[bot]', 'dependabot-preview[bot]']);

function parseCsv(input) {
  if (!input) return [];
  return input
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function getUpdateTypeFromTitle(title) {
  if (!title) return null;
  const match = title.match(/from\s+([^\s]+)\s+to\s+([^\s]+)/i);
  if (!match) return null;
  const from = semver.clean(match[1]);
  const to = semver.clean(match[2]);
  if (!from || !to) return null;
  return semver.diff(from, to);
}

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

function labelsSet(pr) {
  return new Set((pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean));
}

async function processPullRequest(octokit, owner, repo, pr, options) {
  const { allowUpdateTypes, requiredLabels, denyLabels, minApprovals } = options;

  if (!DEPENDABOT_LOGINS.has(pr.user?.login)) {
    core.info(`Skipping PR #${pr.number}: not Dependabot`);
    return;
  }

  if (pr.draft) {
    core.info(`Skipping PR #${pr.number}: draft`);
    return;
  }

  const updateType = getUpdateTypeFromTitle(pr.title);
  if (allowUpdateTypes.length > 0 && updateType && !allowUpdateTypes.includes(updateType)) {
    core.info(`Skipping PR #${pr.number}: update type '${updateType}' not allowed`);
    return;
  }

  const prLabels = labelsSet(pr);
  if (requiredLabels.length > 0) {
    const hasAll = requiredLabels.every((label) => prLabels.has(label));
    if (!hasAll) {
      core.info(`Skipping PR #${pr.number}: missing required label(s)`);
      return;
    }
  }

  if (denyLabels.length > 0) {
    const hasDeny = denyLabels.some((label) => prLabels.has(label));
    if (hasDeny) {
      core.info(`Skipping PR #${pr.number}: has deny label`);
      return;
    }
  }

  if (minApprovals > 0) {
    const reviews = await getReviews(octokit, owner, repo, pr.number);
    const approvals = countApprovals(reviews);
    if (approvals < minApprovals) {
      core.info(`Skipping PR #${pr.number}: approvals ${approvals} < ${minApprovals}`);
      return;
    }
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

async function run() {
  try {
    const token = core.getInput('github_token', { required: true });
    const allowUpdateTypes = parseCsv(core.getInput('allow_update_types'));
    const requiredLabels = parseCsv(core.getInput('require_label'));
    const denyLabels = parseCsv(core.getInput('deny_labels'));
    const minApprovalsInput = core.getInput('min_approvals');
    const minApprovals = minApprovalsInput ? parseInt(minApprovalsInput, 10) : 0;

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    if (github.context.eventName === 'pull_request') {
      const pr = github.context.payload.pull_request;
      if (!pr) {
        core.info('No pull request in context.');
        return;
      }
      await processPullRequest(octokit, owner, repo, pr, {
        allowUpdateTypes,
        requiredLabels,
        denyLabels,
        minApprovals,
      });
      return;
    }

    if (['schedule', 'workflow_dispatch'].includes(github.context.eventName)) {
      const prs = await listOpenDependabotPRs(octokit, owner, repo);
      for (const pr of prs) {
        await processPullRequest(octokit, owner, repo, pr, {
          allowUpdateTypes,
          requiredLabels,
          denyLabels,
          minApprovals,
        });
      }
      return;
    }

    core.info(`Event '${github.context.eventName}' not supported.`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
