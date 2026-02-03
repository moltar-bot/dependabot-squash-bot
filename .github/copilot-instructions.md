# Copilot Instructions

- When evaluating PR checks, **ignore the current workflow run’s own checks/statuses** (the bot can see its own in-progress job as failing).
- Prefer matching the current run by **run id in URLs** (e.g., `checkRun.html_url` or status `target_url` containing `/runs/${GITHUB_RUN_ID}`) rather than generic job names.
- Avoid filtering out checks solely by job name; generic names like `build`/`test` may exist in other workflows.
