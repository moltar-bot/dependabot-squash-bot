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

const CURRENT_WORKFLOW = process.env.GITHUB_WORKFLOW;
const CURRENT_JOB = process.env.GITHUB_JOB;
const CURRENT_RUN_JOB_NAMES = new Set();
const CURRENT_RUN_JOB_IDS = new Set();

function isCurrentWorkflowRun(checkRun) {
  const currentRunId = process.env.GITHUB_RUN_ID;
  if (!currentRunId) return false;
  if (checkRun.external_id && String(checkRun.external_id) === String(currentRunId)) return true;
  if (checkRun.external_id && CURRENT_RUN_JOB_IDS.has(String(checkRun.external_id))) return true;
  if (checkRun.details_url && checkRun.details_url.includes(`/runs/${currentRunId}`)) return true;
  if (checkRun.html_url && checkRun.html_url.includes(`/runs/${currentRunId}`)) return true;
  if (checkRun.check_suite?.url && checkRun.check_suite.url.includes(`/runs/${currentRunId}`)) return true;
  if (checkRun.check_suite?.id && String(checkRun.check_suite.id) === String(currentRunId)) return true;
  return false;
}

function normalizeName(value) {
  return String(value || '').toLowerCase();
}

function matchesJobName(name, job) {
  const normalizedName = normalizeName(name);
  const normalizedJob = normalizeName(job);
  if (!normalizedName || !normalizedJob) return false;
  if (normalizedName === normalizedJob) return true;
  if (normalizedName.startsWith(`${normalizedJob} `)) return true;
  if (normalizedName.startsWith(`${normalizedJob} (`)) return true;
  if (normalizedName.endsWith(` / ${normalizedJob}`)) return true;
  return false;
}

function matchesCurrentRunJobName(name) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) return false;
  for (const jobName of CURRENT_RUN_JOB_NAMES) {
    const normalizedJob = normalizeName(jobName);
    if (!normalizedJob) continue;
    if (normalizedName === normalizedJob) return true;
    if (normalizedName.startsWith(`${normalizedJob} `)) return true;
    if (normalizedName.startsWith(`${normalizedJob} (`)) return true;
    if (normalizedName.endsWith(` / ${normalizedJob}`)) return true;
  }
  return false;
}

function matchesCurrentWorkflowName(name) {
  if (!name) return false;
  const normalizedName = normalizeName(name);
  if (CURRENT_WORKFLOW) {
    const normalizedWorkflow = normalizeName(CURRENT_WORKFLOW);
    if (
      normalizedName === normalizedWorkflow ||
      normalizedName.startsWith(`${normalizedWorkflow} /`)
    ) {
      return true;
    }
  }
  if (CURRENT_JOB && matchesJobName(name, CURRENT_JOB)) {
    return true;
  }
  if (matchesCurrentRunJobName(name)) {
    return true;
  }
  return false;
}

function isCurrentWorkflowCheck(checkRun) {
  if (isCurrentWorkflowRun(checkRun)) return true;
  if (matchesCurrentWorkflowName(checkRun.name)) return true;
  return false;
}

function isCurrentStatusForRun(status) {
  const currentRunId = process.env.GITHUB_RUN_ID;
  if (!currentRunId) return false;
  if (status.target_url && status.target_url.includes(`/runs/${currentRunId}`)) return true;
  if (status.url && status.url.includes(`/runs/${currentRunId}`)) return true;
  return false;
}

function isCurrentWorkflowStatus(status) {
  if (isCurrentStatusForRun(status)) return true;
  if (matchesCurrentWorkflowName(status.context)) return true;
  return false;
}

function latestStatusByContext(statuses) {
  const latest = new Map();
  for (const status of statuses) {
    if (!status.context) continue;
    if (!latest.has(status.context)) {
      latest.set(status.context, status);
    }
  }
  return Array.from(latest.values());
}

function statusChecksArePassing(statuses) {
  const latest = latestStatusByContext(statuses);
  const filtered = latest.filter((status) => !isCurrentWorkflowStatus(status));
  return filtered.every((status) => status.state === 'success');
}

async function checksArePassing(octokit, owner, repo, ref) {
  const [commitStatuses, checkRuns] = await Promise.all([
    octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref,
      per_page: 100,
    }),
    octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 }),
  ]);

  const statusOk = statusChecksArePassing(commitStatuses);
  const runs = checkRuns.data.check_runs || [];
  const filteredRuns = runs.filter((run) => !isCurrentWorkflowCheck(run));
  const runsOk = filteredRuns.every(
    (run) =>
      run.status === 'completed' &&
      (run.conclusion === 'success' ||
        run.conclusion === 'skipped' ||
        run.conclusion === 'neutral')
  );
  return statusOk && runsOk;
}

async function loadCurrentRunJobNames(octokit, owner, repo) {
  const currentRunId = process.env.GITHUB_RUN_ID;
  if (!currentRunId) return;
  try {
    const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: Number(currentRunId),
      per_page: 100,
    });
    const jobList = jobs?.data?.jobs || [];
    for (const job of jobList) {
      if (job?.name) CURRENT_RUN_JOB_NAMES.add(job.name);
      if (job?.id) CURRENT_RUN_JOB_IDS.add(String(job.id));
    }
  } catch (error) {
    core.info(`Unable to load current workflow jobs: ${error.message}`);
  }
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

async function run() {
  try {
    const token = core.getInput('github_token', { required: true });
    const minApprovalsInput = core.getInput('min_approvals');
    const minApprovals = minApprovalsInput ? parseInt(minApprovalsInput, 10) : 1;

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    await loadCurrentRunJobNames(octokit, owner, repo);

    if (github.context.eventName === 'pull_request') {
      const pr = github.context.payload.pull_request;
      if (!pr) {
        core.info('No pull request in context.');
        return;
      }
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
