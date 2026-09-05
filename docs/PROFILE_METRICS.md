# Profile Metrics Contract

Every number shown on the [profile README](../README.md) comes from this
pipeline (`metrics/generate.mjs`). This document defines exactly what each
metric means, where it comes from, and what is intentionally **not** shown.

## Sources (priority order)

1. **GitHub GraphQL** — `viewer.contributionsCollection` over the last 365
   days. Provides the official contribution calendar (**public + private**),
   monthly totals, and per-type public totals.
2. **GitHub REST** — for every **owned, non-fork repository (public +
   private)**:
   - `GET /repos/{owner}/{repo}/commits?author=xiabee&since=<365d>` — commit
     list (dates, parent count).
   - `GET /repos/{owner}/{repo}/languages` — language byte counts.
   - `GET /repos/{owner}/{repo}/stats/contributors` — weekly
     additions/deletions/commits for the author.

The OSSInsight public event feed is **not** used (known under-collection of
recent public events). The private TiDB database behind
[ossinsight.xiabee.cn](https://ossinsight.xiabee.cn) does not contain
commit-level data, so it is not a source for these metrics either.

## Metric definitions

| Metric | Definition | Window |
| --- | --- | --- |
| `Commits` | Non-merge commits authored by `xiabee` in owned repos (public + private) + public commit contributions in external repos | last 365 days |
| `Contributions` | GitHub contribution calendar total (public + private, all types, GitHub's own counting rules) | last 365 days |
| `Active Days` | Calendar days with ≥ 1 contribution | last 365 days |
| `Repos Touched` | Distinct repositories with ≥ 1 qualifying commit | last 365 days |
| `Lines Added / Deleted` | Sum of weekly `additions`/`deletions` from `stats/contributors` (7-day buckets; the bucket containing the window start is included whole) | last 365 days |
| `Contribution Trend` | Calendar contributions bucketed by month | last 12 months |
| `Coding Rhythm` | Contribution calendar heatmap (GitHub-style, weeks × weekday) | last 12 months |
| `Languages · All Time` | Sum of `languages` byte counts across owned non-fork repos, programming languages only | all time |
| `Languages · Last 90 Days` | Commit-weighted average of per-repo language byte shares, over repos with ≥ 1 commit in the window | last 90 days |
| `last 90 days` strip | Same definitions as above with a 90-day window | last 90 days |

### Rules and caveats

- **Timezone**: day boundaries follow GitHub's contribution calendar;
  weekday × hour aggregation (if shown) uses `Asia/Shanghai`. The refresh
  workflow runs at 03:00 Asia/Shanghai (`0 19 * * *` UTC).
- **Merge commits** are excluded (`parents.length ≤ 1`).
- **Bots**: only commits whose author matches the `xiabee` account are
  counted; no other authors or bots are included.
- **Forks** are excluded from owned-repo aggregation.
- **Dedupe**: a commit is counted once per repository it was queried in;
  mirrored copies inside the owned set would count twice (rare, accepted).
- **Private repos** are included in aggregates only. GitHub's GraphQL does
  not itemize private contributions (`restrictedContributionsCount` only),
  which is why owned repos are walked via REST with a `repo`-scoped token.
- **Lines added/deleted** include vendored or generated code inside private
  repos. They are an *activity* indicator, not a skill ranking.
- Markup/data languages (HTML, CSS, JSON, YAML, Markdown, …) are excluded
  from the language distribution so the mix reflects programming languages.
- If the private-access token is unavailable the pipeline falls back to
  public-only data and `metrics.json` records `scope: "public-only"`.

## Privacy

Outputs (SVGs + `metrics.json`) contain **aggregates only**. Repository
names, commit messages, paths, and issue/PR titles are never written to any
committed file; `metrics/generate.mjs` enforces this with a blocklist check
(privacy gate) over every output before it is written. Raw API responses are
kept in `metrics/cache/` which is gitignored.

## Refresh

`.github/workflows/metrics.yml` regenerates all SVGs daily at
03:00 Asia/Shanghai and commits only changed files. `METRICS_TOKEN` (a
`repo`-scoped token allowing private contribution aggregation) is stored as
a repository secret and never appears in logs, code, or artifacts.
