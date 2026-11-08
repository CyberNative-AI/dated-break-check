# Dated break check

**A warning in your build before a dated upstream change hits your repository: an image tag that moves, an API or model that shuts down, a runner that is retired.**

Each run reads your repository's files on the runner and runs the published search of every date on the [Breakage Calendar](https://cybernative.ai/breakage-calendar/) that a repository's files can show. A date that matches gets a warning on the line that will break, with the date, the days left and a link to the tested fix. Nothing from your repository leaves the runner.

Example: the log of a run on a small test repository on 8 November 2026. Each line is also a warning on that file and line, so a pull request shows it beside the code:

```
2026-11-19  in 11 days                Hits this repository      postgres:latest becomes 19  compose.yaml:3
2026-12-01  in 23 days                Hits this repository      OpenAI removes older GPT Image models  app/images.py:4
```

The job summary lists every matching date in a table.

## Setup

Add `.github/workflows/dated-breaks.yml`:

```yaml
name: Dated breaks
on:
  pull_request:
  schedule:
    - cron: '17 6 * * 1'   # every Monday, so a new date reaches you without a code change
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: CyberNative-AI/dated-break-check@COMMIT_SHA   # pin the release commit
        with:
          fail-within: ${{ github.event_name == 'schedule' && '14' || '' }}
```

On pull requests the step only warns. On the weekly run it fails when a matching date is 14 days away or fewer, so GitHub tells you through its usual failed-workflow notice.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | Folder to read, relative to the workspace. |
| `days` | `120` | Report dates up to this many days ahead. Dates that took effect in the last 30 days are reported too. |
| `fail-within` | empty | Fail when a date that hits the repository is this many days away or fewer. `0` fails only once it is in effect. Empty: warn only. |
| `data` | `live` | `live` reads the current calendar from cybernative.ai. `bundled` uses the copy in this version and makes no request. |

## What it reads and sends

- It reads text files up to 1 MB in the checked-out folder, at most 20,000 files, and skips `.git`, `node_modules`, virtual environments and build output.
- With `data: live` it makes two GET requests to public files, `https://cybernative.ai/breakage-calendar/entries.json` and `https://cybernative.ai/breakage-calendar/check/signatures.json`, with the user agent `dated-break-check/0.1`. Like any web request, these show our server the runner's IP address and the time. Nothing about your repository is sent. If the files cannot be read, the step says so and uses the bundled copy.
- With `data: bundled` it makes no network request.

## Limits

- It finds names as they are written in your files. An image tag, model name or runner label built at run time from a variable is not seen.
- Some dates cannot show in a repository's files at all (a certificate's expiry, a service you only call from a dashboard). The calendar lists them; this step does not.
- "May hit this repository" means the files use what the date affects and only some setups break; the linked page says which.
- The matcher in `src/match.js` is a copy of the one the browser check at <https://cybernative.ai/breakage-calendar/check/> runs, so the two give the same answer for the same files.

## About

No dependencies. Built and maintained by **CyberNative AI LLC**, an AI-run company. The Action, the calendar and this README were written by AI agents. Report a wrong or missing date as an issue on this repository, using public code only. Apache License 2.0.
