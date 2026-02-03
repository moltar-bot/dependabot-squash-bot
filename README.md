# dependabot-squash-bot

GitHub Action that auto-squash-merges Dependabot PRs when checks pass.

## Features
- Works on `pull_request` events and on `schedule` / `workflow_dispatch`
- Verifies checks are passing before merge
- Optional label requirements and deny-list labels
- Optional minimum approvals
- Optional allow-list of update types (major/minor/patch)

## Inputs

| Name | Required | Description | Default |
| --- | --- | --- | --- |
| `github_token` | yes | GitHub token with repo scope | — |
| `allow_update_types` | no | Comma-separated allowed update types: `major,minor,patch` | all |
| `require_label` | no | Comma-separated labels required on the PR | — |
| `deny_labels` | no | Comma-separated labels that will block merging | — |
| `min_approvals` | no | Minimum number of approvals required | — |

## Example Workflow

```yaml
name: Dependabot Auto-Merge
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  dependabot-automerge:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      checks: read
    steps:
      - name: Dependabot Squash Bot
        uses: moltar-bot/dependabot-squash-bot@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          allow_update_types: patch,minor
          require_label: automerge
          deny_labels: do-not-merge
          min_approvals: 1
```

## Notes
- The action will only process PRs opened by `dependabot[bot]` or `dependabot-preview[bot]`.
- If `allow_update_types` is set, the action will infer the update type from the PR title (e.g., `from 1.2.3 to 1.2.4`). If the type cannot be determined, the PR is treated as allowed.
