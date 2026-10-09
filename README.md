# yukaichou.com watchdog

Every 5 minutes a GitHub Actions run checks that yukaichou.com answers, past all caches. If the site
fails three checks in a row (about 80 seconds), it restarts the site's PHP engine through the Kinsta API,
at most once every 30 minutes. It also opens a GitHub issue labelled `outage`, which emails the repo
owner. The next healthy run closes the issue.

Built after the 2026-10-09 freeze: the Kinsta container stopped accepting connections for 16 minutes
and came back only after a PHP restart.

Setup: the `KINSTA_API_KEY` secret plus the `KINSTA_ENV_ID` and `KINSTA_COMPANY_ID` repository variables.
Without the key it still detects and alerts. Run it by hand from Actions → watchdog → Run workflow.
"Dry run" (the default) never restarts.
