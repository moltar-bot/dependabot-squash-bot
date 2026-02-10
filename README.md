# dependabot-squash-bot

GitHub Action that auto-squash-merges Dependabot PRs when checks pass.

## Features
- Works on `pull_request` events and on `schedule` / `workflow_dispatch`
- Verifies checks are passing before merge
- Required approvals (configurable minimum)

## Inputs

| Name | Required | Description | Default |
| --- | --- | --- | --- |
| `github_token` | yes | GitHub token with repo scope | — |
| `min_approvals` | no | Minimum number of approvals required | 1 |
| `ignore_checks` | no | Comma-separated list of check/run names to ignore when evaluating check status | — |

## Example Workflow

```yaml
name: Dependabot Auto-Merge
on:
  pull_request:
    types: [opened, synchronize, reopened]
  pull_request_review:
    types: [submitted]
  schedule:
    - cron: '*/15 * * * *'
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
          min_approvals: 1
```

## Notes
- The action will only process PRs opened by `dependabot[bot]` or `dependabot-preview[bot]`.
