# Dated break check

**Fails your weekly build when a file in your repository uses something a dated upstream change will break within 14 days: an image tag that moves, an API or model that shuts down, a runner that is retired. On pull requests it warns on the line instead.**

Run on a clone of [docker/awesome-compose](https://github.com/docker/awesome-compose) on 13 November 2026, it printed:

```
2026-11-19  in 6 days                 Hits this repository      postgres:latest becomes 19  spring-postgres/compose.yaml:11
```

That line is `image: postgres`, which means `postgres:latest`. The warning links to [the page](https://cybernative.ai/guides/postgres-latest-19-docker-error-in-18-upgrade/) that says which setups stop starting and how to pin or upgrade.

The job summary lists every matching date in a table. The [Example run](https://github.com/CyberNative-AI/dated-break-check/actions/workflows/example.yml) workflow runs this step on the files in [`examples/demo`](examples/demo) on every change here, so its latest run shows the warnings and the summary as GitHub displays them.

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
      - uses: CyberNative-AI/dated-break-check@dce1a1ad1e63db0191c15159d3bdad35ba0cb5a1   # v1.0.0: the release's code commit
        with:
          fail-within: ${{ github.event_name == 'schedule' && '14' || '' }}
```

On pull requests the step only warns: each match is an annotation on the file and line. On the Monday run it fails when a date that hits the repository is 14 days away or fewer, so GitHub's usual failed-workflow notice tells you. You need no account, no token and no email address.

The example pins the full commit of a reviewed release, so the code that reads your files changes only when you change that line. To take fixes as they are released instead, use `CyberNative-AI/dated-break-check@v1`; that tag moves to each later 1.x release.

A date that has already taken effect keeps failing the weekly run for 30 days after it, as long as your files still use what it changed. For example, a repository still on `postgres:latest` after 19 November gets a red Monday build it did not have the week before. That is on purpose: the change has already reached that repository. Fix or pin the line the warning names, and the next run passes. Only "Hits this repository" fails a run; "May hit this repository" only warns.

## What it checks, and where the dates come from

The dates come from the [Breakage Calendar](https://cybernative.ai/breakage-calendar/): dated upstream changes that break running software, each with who is affected, how to check, its primary sources and our tested fix where we have one. Many of these changes arrive with no version bump in your repository: a tag like `latest` moves under you, a vendor removes an API or model on a date, a runner image changes.

For every calendar date that a repository's files can show, the calendar publishes a search: the image tags, model names, API paths, package names or runner labels that the change affects. The step runs those searches over your files on the runner. A file that uses the affected thing in a form the change breaks is "Hits this repository"; a file that uses it where only some setups break is "May hit this repository", and the linked page says which. Each Monday run reads the current calendar, so a date added this week reaches you with no change on your side.

To try the same searches before adding anything, open the [browser check](https://cybernative.ai/breakage-calendar/check/) and pick a folder: it runs in your browser and uploads nothing.

On GitLab, the same check is a CI/CD component: [`cybernative-ai-llc/dated-break-check`](https://gitlab.com/cybernative-ai-llc/dated-break-check) in the GitLab CI/CD Catalog. It uses copies of this step's matcher and data, so it gives the same answer for the same files, and it reports in the merge request's Code Quality widget.

Coding agents can ask the same question through the [Breakage Calendar MCP server](https://github.com/CyberNative-AI/breakage-calendar-mcp) (`ai.cybernative/breakage-calendar` in the MCP registry), for example before they upgrade a repository. It runs the same matcher as this step. The calendar's plain JSON files are documented at <https://cybernative.ai/breakage-calendar/api/>.

## What else does this, and when to use it instead

- **Dependabot or Renovate** bump versions you have pinned. Renovate's digest pinning turns the `postgres:latest` move into a pull request you merge on your schedule, and if your images and packages are all pinned and kept current that way, you need this check less. Neither warns before a dated shutdown of an API, a model or a runner, which no version bump shows.
- **[endoflife.date](https://endoflife.date/)** covers end-of-life dates for hundreds of runtimes, operating systems and other products, with a free API, and does that better than we do. It does not cover moving image tags, API or model shutdowns, or runner changes.
- **AI model retirement scanners** such as [llm-sunset](https://github.com/Ashveil1/llm-sunset) and [llm-model-deprecation](https://github.com/techdevsynergy/llm-model-deprecation) cover more providers and models than the calendar does. If model ids are your only exposure, use one of them.
- **[Last Call](https://github.com/marketplace/actions/last-call-deprecation-check)** is the closest thing to this check: a weekly Action that matches your files against a public calendar of announced shutdowns, with line annotations and a summary table. Its calendar is stronger on SaaS and cloud-service sunsets and version end-of-life. On 13 November 2026 it held 1 of the 20 upcoming dates this check searches for outside AI models (OpenAI Evals), so the two overlap little and running both is reasonable.
- **[Footgun Scan](https://github.com/marketplace/actions/footgun-scan)** checks code against known traps and breaking changes in third-party SaaS APIs and AI coding tools.
- **GitHub's own deprecation annotations** cover GitHub Actions and runner retirements at the source, but not other vendors.

This check covers the tail between them: image tags that move under you (`postgres:latest`, `node:latest`), images that drop a tool (PHP 8.6 and pecl), runner changes outside GitHub Actions, data feeds and APIs that change shape or shut down (USGS, Socrata, LaunchDarkly), and removals on a known date (Chrome 158 drops XSLT, Homebrew drops protobuf@21), each with a tested fix where we have one.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | Folder to read, inside the workspace. |
| `days` | `120` | Report dates up to this many days ahead. Dates that took effect in the last 30 days are reported too. |
| `fail-within` | empty | Fail when a date that hits the repository is this many days away or fewer. `0` fails only once it is in effect. Empty: warn only. |
| `data` | `live` | `live` reads the current calendar from cybernative.ai. `bundled` uses the copy in this version and makes no request. |

## What it reads and sends

- It reads text files up to 1 MB in the chosen folder, at most 20,000 files and 512 MB in all, and skips `.git`, `node_modules`, virtual environments and build output. `path` must be a folder inside the workspace; symlinks are not followed.
- With `data: live` it makes two GET requests with no body, to `https://cybernative.ai/breakage-calendar/entries.json` and `https://cybernative.ai/breakage-calendar/check/signatures.json`, with the user agent `dated-break-check/1.0 (+https://github.com/CyberNative-AI/dated-break-check)`, and refuses redirects. Like any web request, these show our server the runner's IP address and the time. Nothing from your repository is in them. If the files cannot be read or are not in the expected form, the step says so and uses the bundled copy.
- With `data: bundled` it makes no network request.
- What it finds (dates, file names and line numbers) goes where every step's output goes: the job log, the annotations and the job summary, which GitHub keeps with the workflow run. Anyone who can see the repository's Actions runs can read them; on a public repository, that is anyone.

## Limits

- The search runs in a separate thread with a 5-minute deadline and a 256 MB limit on its JavaScript heap; the step as a whole can use more memory than that. If the thread reaches the deadline or the heap limit, or fails, the step fails and reports nothing, rather than passing as clean. If it reaches the file or size limit above, it warns that the folder was only partly read, and the weekly run (with `fail-within`) fails. Set `path` to a smaller folder in either case.
- It finds names as they are written in your files. An image tag, model name or runner label built at run time from a variable is not seen.
- Some dates cannot show in a repository's files at all (a certificate's expiry, a service you only call from a dashboard). The calendar lists them; this step does not.
- "May hit this repository" means the files use what the date affects and only some setups break; the linked page says which.
- The matcher in `src/match.js` is a copy of the one the browser check at <https://cybernative.ai/breakage-calendar/check/> runs, so the two give the same answer for the same files.

## About

No dependencies. **CyberNative AI LLC** builds and maintains this Action and the calendar. Prepared by CyberNative AI LLC, an AI-run company, using AI agents. Report a wrong or missing date as an issue on this repository, using public code only. Apache License 2.0.
