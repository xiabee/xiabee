#!/usr/bin/env node
/**
 * XiaBee profile metrics generator.
 *
 * Data sources:
 *   1. GitHub GraphQL contributionsCollection — the official contribution
 *      calendar (public + private), monthly trend, active days.
 *   2. GitHub REST — per-repository commit counts, code-language bytes and
 *      weekly additions/deletions across OWNED repositories (public + private).
 *
 * Privacy contract:
 *   - Per-repository data (names, commits, byte counts) exists only in
 *     memory. Outputs are aggregates only, and every output file is checked
 *     against a blocklist of all fetched repo names before being written.
 *   - metrics/cache/ (raw API dumps, local debugging only) is gitignored.
 *
 * See docs/PROFILE_METRICS.md for the exact metric definitions.
 *
 * Zero runtime dependencies. Node >= 18.
 */

const OUT_DIR = new URL('../assets/metrics/', import.meta.url);
const CACHE = new URL('./cache/raw.json', import.meta.url);
const METRICS_JSON = new URL('./metrics.json', import.meta.url);

const LOGIN = 'xiabee';
const TZ = 'Asia/Shanghai';
const YEAR_DAYS = 365;
const RECENT_DAYS = 90;

const token = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN || '';
const HAS_PRIVATE_ACCESS = Boolean(process.env.METRICS_TOKEN);

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

// Languages classified by linguist as markup/data/prose rather than
// programming languages; excluded from the language distribution.
const NON_PROGRAMMING = new Set([
  'HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Stylus', 'Jupyter Notebook',
  'Markdown', 'JSON', 'YAML', 'TOML', 'XML', 'SVG', 'TeX', 'Vue', 'MDX',
  'Astro', 'Rich Text Format', 'Text', 'reStructuredText', 'AsciiDoc',
  'CSV', 'TSV', 'INI', 'Properties', 'Gherkin', 'Graphviz (DOT)',
]);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function gql(query, variables = {}) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

function restHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** GET a REST path; returns null for missing/empty/inaccessible resources.
 *  Errors are scrubbed of repo names: this runs in public CI logs. */
async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: restHeaders() });
  if ([403, 404, 409, 451].includes(res.status)) return null;
  if (!res.ok) throw new Error(`REST request failed (HTTP ${res.status}) at [path redacted]`);
  const link = res.headers.get('link');
  const data = await res.json();
  if (Array.isArray(data) && link && /rel="next"/.test(link)) {
    const next = link.match(/<([^>]+)>; rel="next"/)[1];
    return data.concat(await restUrl(next));
  }
  return data;
}

async function restUrl(url) {
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`REST request failed (HTTP ${res.status}) at [path redacted]`);
  const data = await res.json();
  const link = res.headers.get('link');
  if (Array.isArray(data) && link && /rel="next"/.test(link)) {
    const next = link.match(/<([^>]+)>; rel="next"/)[1];
    return data.concat(await restUrl(next));
  }
  return data;
}

/** stats/contributors returns 202 while the cache warms; retry with enough
 *  patience that big repositories are not silently dropped from the totals
 *  (dropped repos would make the numbers drift between runs). */
async function restStats(path, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`https://api.github.com${path}`, { headers: restHeaders() });
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if ([403, 404, 409, 451].includes(res.status)) return null;
    if (!res.ok) throw new Error(`REST stats request failed (HTTP ${res.status}) at [path redacted]`);
    return await res.json();
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetch: contribution calendar (GraphQL)
// ---------------------------------------------------------------------------

const CONTRIBUTIONS_QUERY = `
query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      totalRepositoriesWithContributedCommits
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { date contributionCount }
        }
      }
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner owner { login } }
        contributions { totalCount }
      }
    }
  }
}`;

function calendarDays(cc) {
  const days = [];
  for (const week of cc.contributionCalendar.weeks) {
    for (const day of week.contributionDays) days.push(day);
  }
  return days;
}

function monthBuckets(days) {
  const buckets = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    buckets.set(key, (buckets.get(key) || 0) + d.contributionCount);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, count]) => ({ month, count }));
}

// ---------------------------------------------------------------------------
// Fetch: owned repositories (REST)
// ---------------------------------------------------------------------------

async function fetchOwnedRepos() {
  const repos = await rest(`/user/repos?type=owner&sort=pushed&per_page=100`);
  if (!Array.isArray(repos)) return [];
  return repos.filter((r) => !r.fork && r.owner?.login?.toLowerCase() === LOGIN);
}

async function fetchRepoCommits(repo, sinceIso) {
  const commits = await rest(
    `/repos/${repo.full_name}/commits?author=${LOGIN}&since=${sinceIso}&per_page=100`
  );
  if (!Array.isArray(commits)) return [];
  return commits
    .filter((c) => Array.isArray(c.parents) && c.parents.length <= 1) // exclude merges
    .map((c) => ({
      date: c.commit.author.date,
    }));
}

async function fetchRepoLanguages(repo) {
  const bytes = await rest(`/repos/${repo.full_name}/languages`);
  return bytes || {};
}

async function fetchRepoStats(repo) {
  const stats = await restStats(`/repos/${repo.full_name}/stats/contributors`);
  if (!Array.isArray(stats)) return null;
  const mine = stats.find((s) => s.author?.login?.toLowerCase() === LOGIN);
  return mine ? mine.weeks : null;
}

/** Sum additions/deletions/commits over stat weeks overlapping [since, now]. */
function sumStatsWeeks(weeks, sinceMs) {
  let a = 0, d = 0, c = 0;
  for (const w of weeks) {
    if (w.w * 1000 >= sinceMs) {
      a += w.a; d += w.d; c += w.c;
    }
  }
  return { additions: a, deletions: d, commits: c };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function isProgramming(name) {
  return name && !NON_PROGRAMMING.has(name);
}

function topLanguages(map, n = 6) {
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((a, [, b]) => a + b, 0);
  const out = top.map(([name, bytes]) => ({
    name,
    percent: +((bytes / total) * 100).toFixed(1),
  }));
  if (rest > 0) out.push({ name: 'Other', percent: +((rest / total) * 100).toFixed(1) });
  return out;
}

/** weekday (1=Mon..7=Sun) x hour matrix in the profile timezone. */
function weekdayHourMatrix(commitDates) {
  const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });
  const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const iso of commitDates) {
    const wd = fmtWeekday.format(new Date(iso));
    const hr = parseInt(fmtHour.format(new Date(iso)), 10) % 24;
    matrix[order.indexOf(wd)][hr] += 1;
  }
  return matrix;
}

function fmtDate(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

const THEMES = {
  dark: {
    bg: '#0A1929', cardBg: '#102A43', cardBorder: '#1E3A5F',
    title: '#F0F6FC', text: '#C9D9E8', muted: '#7D93AC',
    accent: '#4CC2FF', accent2: '#A371F7', green: '#2BD576',
    grid: '#1B3552', heat: ['#12283E', '#1D5C87', '#2E8BC9', '#4CC2FF'],
    heatZero: '#0E2036', area: 'rgba(76,194,255,0.32)', areaLine: '#4CC2FF',
    bar1: '#4CC2FF', bar2: '#2BD576',
  },
  light: {
    bg: '#F6F8FA', cardBg: '#FFFFFF', cardBorder: '#D8DEE4',
    title: '#1F2328', text: '#3D444D', muted: '#77808A',
    accent: '#0969DA', accent2: '#8250DF', green: '#1A7F37',
    grid: '#E7EBEF', heat: ['#DBE7F4', '#9CC3E5', '#4C97D4', '#0969DA'],
    heatZero: '#EDF1F5', area: 'rgba(9,105,218,0.16)', areaLine: '#0969DA',
    bar1: '#0969DA', bar2: '#1A7F37',
  },
};

const FONT = `-apple-system,'Segoe UI','Helvetica Neue',Arial,sans-serif`;
const MONO = `ui-monospace,'Cascadia Code','SF Mono',Consolas,monospace`;
const W = 1012; // GitHub profile content width

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgOpen(h, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" font-family="${FONT}" role="img" aria-label="${esc(t)}">`;
}

function card(t, x, y, w, h, rx = 10) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>`;
}

function fmt(n) {
  return Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// --- Overview: metric tiles ---------------------------------------------------

function renderOverview(m, t) {
  const H = 264;
  const o = m.overview;
  const tiles = [
    { label: 'COMMITS', value: fmt(o.commits), color: t.accent },
    { label: 'CONTRIBUTIONS', value: fmt(o.totalContributions), color: t.green },
    { label: 'ACTIVE DAYS', value: fmt(o.activeDays), color: t.accent2 },
    { label: 'REPOS TOUCHED', value: fmt(o.repositoriesTouched), color: t.accent },
    { label: 'LINES ADDED', value: '+' + fmt(o.additions), color: t.green },
    { label: 'LINES DELETED', value: '-' + fmt(o.deletions), color: t.accent2 },
  ];
  const gap = 12;
  const cw = (W - gap * 2 - 24 * 2) / 3;
  const ch = 86;
  let out = svgOpen(H, `XiaBee GitHub development overview: ${o.commits} commits, ${o.activeDays} active days in the last 365 days across public and private repositories`);
  out += `<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`;
  out += `<text x="24" y="36" fill="${t.title}" font-size="17" font-weight="700" letter-spacing="0.4">Development Activity</text>`;
  out += `<rect x="${W - 328}" y="20" width="304" height="23" rx="11.5" fill="${t.cardBg}" stroke="${t.cardBorder}"/>`;
  out += `<text x="${W - 176}" y="36" text-anchor="middle" fill="${t.muted}" font-size="11.5">last 365 days · public + private</text>`;
  tiles.forEach((tile, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 24 + col * (cw + gap);
    const y = 54 + row * (ch + gap);
    out += card(t, x, y, cw, ch);
    out += `<rect x="${x}" y="${y + 15}" width="4" height="${ch - 30}" rx="2" fill="${tile.color}"/>`;
    out += `<text x="${x + 20}" y="${y + 32}" fill="${t.muted}" font-size="12" letter-spacing="1.1">${esc(tile.label)}</text>`;
    out += `<text x="${x + 20}" y="${y + 70}" fill="${t.title}" font-size="33" font-weight="800" font-family="${MONO}">${esc(tile.value)}</text>`;
  });
  out += `</svg>`;
  return out;
}

// --- Trend: monthly area chart -------------------------------------------------

function renderTrend(m, t) {
  const H = 250;
  const pad = { l: 46, r: 24, top: 54, bottom: 32 };
  const data = m.monthly;
  const max = Math.max(...data.map((d) => d.count), 10);
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.top - pad.bottom;
  const x = (i) => pad.l + (i / Math.max(data.length - 1, 1)) * innerW;
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  let path = '';
  data.forEach((d, i) => {
    path += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`;
  });
  const area =
    path +
    `L${x(data.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pad.l},${(pad.top + innerH).toFixed(1)} Z`;

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = pad.top + (innerH / 4) * g;
    const val = Math.round(max - (max / 4) * g);
    grid += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="${t.grid}" stroke-width="1"/>`;
    grid += `<text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" fill="${t.muted}" font-size="10.5" font-family="${MONO}">${val}</text>`;
  }

  let labels = '';
  const labelEvery = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    if (i % labelEvery === 0) {
      const [yy, mm] = d.month.split('-');
      const name = new Date(Date.UTC(+yy, +mm - 1, 1)).toLocaleString('en-US', {
        month: 'short', timeZone: 'UTC',
      });
      labels += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="${t.muted}" font-size="10.5">${name}${+mm === 1 ? ` '${yy.slice(2)}` : ''}</text>`;
    }
  });

  const peakIdx = data.reduce((best, d, i) => (d.count > data[best].count ? i : best), 0);
  const peak = data[peakIdx];
  const [pyy, pmm] = peak.month.split('-');
  const peakName = new Date(Date.UTC(+pyy, +pmm - 1, 1)).toLocaleString('en-US', {
    month: 'short', timeZone: 'UTC',
  });
  // Keep the peak label inside the plot: below the point when near the top,
  // end-anchored when near the right edge.
  const px = x(peakIdx);
  const py = y(peak.count);
  const labelAbove = py - 12 >= pad.top + 4;
  const labelY = labelAbove ? py - 12 : py + 22;
  const nearRight = px > W - pad.r - 90;
  const nearLeft = px < pad.l + 90;
  const labelAnchor = nearRight ? 'end' : nearLeft ? 'start' : 'middle';
  const labelX = nearRight ? Math.min(px + 8, W - pad.r) : nearLeft ? Math.max(px - 8, pad.l) : px;

  let out = svgOpen(H, `XiaBee monthly GitHub contribution trend over the last 12 months, public and private`);
  out += `<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`;
  out += `<text x="24" y="32" fill="${t.title}" font-size="16" font-weight="700">Contribution Trend</text>`;
  out += `<text x="${W - 24}" y="32" text-anchor="end" fill="${t.muted}" font-size="11.5">last 90 days: ${m.last90Days.totalContributions} contributions · ${m.last90Days.activeDays} active days</text>`;
  out += grid;
  out += `<path d="${area}" fill="${t.area}"/>`;
  out += `<path d="${path}" fill="none" stroke="${t.areaLine}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  out += `<circle cx="${x(peakIdx)}" cy="${y(peak.count)}" r="4.5" fill="${t.areaLine}" stroke="${t.bg}" stroke-width="2"/>`;
  out += `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${labelAnchor}" fill="${t.text}" font-size="11" font-weight="600" font-family="${MONO}">${peak.count} · ${peakName}</text>`;
  out += labels;
  out += `</svg>`;
  return out;
}

// --- Heatmap: contribution calendar ---------------------------------------------

function renderHeatmap(m, t) {
  const H = 196;
  const cell = 13;
  const gap = 3;
  const left = 30;
  const top = 48;
  const days = m.calendar;
  const weeks = [];
  let week = Array(7).fill(null);
  days.forEach((d) => {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 && week.some((c) => c !== null)) {
      weeks.push(week);
      week = Array(7).fill(null);
    }
    week[dow] = d;
  });
  if (week.some((c) => c !== null)) weeks.push(week);

  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const thresholds = [1, Math.ceil(maxCount * 0.25), Math.ceil(maxCount * 0.55), Math.ceil(maxCount * 0.85)];
  const colorFor = (count) => {
    if (!count) return t.heatZero;
    for (let i = 3; i >= 0; i--) if (count >= thresholds[i]) return t.heat[i];
    return t.heat[0];
  };

  let cells = '';
  weeks.forEach((w, wi) => {
    w.forEach((d, di) => {
      if (!d) return;
      const fill = colorFor(d.count);
      const stroke = d.count === 0 ? t.grid : 'none';
      cells += `<rect x="${(left + wi * (cell + gap)).toFixed(1)}" y="${top + di * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${fill}"${stroke !== 'none' ? ` stroke="${stroke}" stroke-width="1"` : ''}><title>${d.date}: ${d.count} contributions</title></rect>`;
    });
  });

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let monthLabels = '';
  let lastMonth = -1;
  weeks.forEach((w, wi) => {
    const firstDay = w.find((c) => c !== null);
    if (!firstDay) return;
    const mIdx = +firstDay.date.slice(5, 7) - 1;
    if (mIdx !== lastMonth) {
      lastMonth = mIdx;
      monthLabels += `<text x="${(left + wi * (cell + gap)).toFixed(1)}" y="${top - 8}" fill="${t.muted}" font-size="10">${months[mIdx]}</text>`;
    }
  });

  let dowText = '';
  ['Mon', 'Wed', 'Fri'].forEach((lbl, i) => {
    dowText += `<text x="${left - 8}" y="${top + i * 2 * (cell + gap) + cell - 3}" text-anchor="end" fill="${t.muted}" font-size="10">${lbl}</text>`;
  });

  const rowY = top + 7 * (cell + gap) + 2;
  const lx = W - 24 - 146; // "Less" + 5 cells + "More"
  let legend = `<text x="${lx}" y="${rowY + cell - 3}" fill="${t.muted}" font-size="10">Less</text>`;
  for (let i = 0; i < 4; i++) {
    legend += `<rect x="${lx + 34 + i * (cell + gap)}" y="${rowY}" width="${cell}" height="${cell}" rx="3" fill="${t.heat[i]}"/>`;
  }
  legend += `<rect x="${lx + 34 + 4 * (cell + gap)}" y="${rowY}" width="${cell}" height="${cell}" rx="3" fill="${t.heatZero}" stroke="${t.grid}"/>`;
  legend += `<text x="${lx + 34 + 5 * (cell + gap) + 6}" y="${rowY + cell - 3}" fill="${t.muted}" font-size="10">More</text>`;

  let out = svgOpen(H, `XiaBee GitHub contribution calendar heatmap for the last 12 months, public and private contributions`);
  out += `<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`;
  out += `<text x="24" y="28" fill="${t.title}" font-size="16" font-weight="700">Coding Rhythm</text>`;
  out += `<text x="${W - 24}" y="28" text-anchor="end" fill="${t.muted}" font-size="11.5">${m.overview.totalContributions} contributions · ${m.overview.activeDays} active days</text>`;
  out += monthLabels + dowText + cells + legend;
  out += `</svg>`;
  return out;
}

// --- Languages: all-time vs recent bars -------------------------------------------

function renderLanguages(m, t) {
  const H = 300;
  const colW = (W - 24 * 2 - 44) / 2;

  function column(langs, x, title, color, sub) {
    let out = `<text x="${x}" y="60" fill="${t.title}" font-size="13.5" font-weight="700">${esc(title)}</text>`;
    out += `<text x="${x}" y="77" fill="${t.muted}" font-size="10.5">${esc(sub)}</text>`;
    const barW = colW - 106;
    langs.forEach((lang, i) => {
      const y = 96 + i * 29;
      out += `<text x="${x}" y="${y + 10}" fill="${t.text}" font-size="11.5" font-weight="600">${esc(lang.name)}</text>`;
      out += `<rect x="${x}" y="${y + 14}" width="${barW}" height="7" rx="3.5" fill="${t.heatZero}" stroke="${t.grid}" stroke-width="1"/>`;
      out += `<rect x="${x}" y="${y + 14}" width="${Math.max((barW * lang.percent) / 100, 2).toFixed(1)}" height="7" rx="3.5" fill="${color}" opacity="${1 - i * 0.09}"/>`;
      out += `<text x="${x + barW + 10}" y="${y + 10}" fill="${t.muted}" font-size="11" font-family="${MONO}">${lang.percent}%</text>`;
    });
    return out;
  }

  let out = svgOpen(H, `XiaBee language distribution: all time versus last 90 days, based on actual code bytes`);
  out += `<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`;
  out += `<text x="24" y="32" fill="${t.title}" font-size="16" font-weight="700">Languages</text>`;
  out += `<text x="${W - 24}" y="32" text-anchor="end" fill="${t.muted}" font-size="11.5">code-based · public + private</text>`;
  out += column(m.languages.allTime, 24, 'All Time', t.bar1, 'owned repositories');
  out += column(m.languages.recent, 24 + colW + 44, 'Last 90 Days', t.bar2, 'commit-weighted · active repos');
  out += `</svg>`;
  return out;
}

// ---------------------------------------------------------------------------
// Privacy gate + main
// ---------------------------------------------------------------------------

function assertNoRepoNames(files, repoNames) {
  const offenders = [];
  for (const [path, content] of files) {
    const lower = content.toLowerCase();
    for (const name of repoNames) {
      const n = name.toLowerCase().split('/').pop();
      // The login itself (and the xiabee/xiabee profile repo) legitimately
      // appears in labels; every other repo name is a leak.
      if (n === LOGIN) continue;
      if (n && n.length > 2 && lower.includes(n)) offenders.push(`${path} contains "${n}"`);
    }
  }
  if (offenders.length) throw new Error(`PRIVACY GATE TRIPPED:\n${offenders.join('\n')}`);
}

async function main() {
  if (!token) throw new Error('Set METRICS_TOKEN (or GITHUB_TOKEN)');
  const now = new Date();
  const from365 = fmtDate(new Date(now - YEAR_DAYS * 86400e3));
  const since90 = new Date(now - RECENT_DAYS * 86400e3);

  console.log('GraphQL: contributions ...');
  const data = await gql(CONTRIBUTIONS_QUERY, { from: from365, to: fmtDate(now) });
  const data90 = await gql(CONTRIBUTIONS_QUERY, { from: fmtDate(since90), to: fmtDate(now) });
  const viewer = data.viewer;
  if (viewer.login.toLowerCase() !== LOGIN) throw new Error(`Unexpected viewer ${viewer.login}`);
  const cc = viewer.contributionsCollection;
  const cc90 = data90.viewer.contributionsCollection;

  const days = calendarDays(cc);
  const activeDays = days.filter((d) => d.contributionCount > 0).length;

  // Public commit contributions in repositories NOT owned by the user
  // (e.g. upstream OSS repos). Owned repos are counted via REST below.
  const externalCommits = [];
  const externalRepoNames = new Set();
  for (const r of cc.commitContributionsByRepository) {
    const owner = r.repository?.owner?.login?.toLowerCase();
    if (owner && owner !== LOGIN) {
      externalCommits.push({ repo: r.repository.nameWithOwner, count: r.contributions.totalCount });
      externalRepoNames.add(r.repository.nameWithOwner);
    }
  }
  const externalCommitTotal365 = externalCommits.reduce((a, r) => a + r.count, 0);
  const externalCommitTotal90 = cc90.commitContributionsByRepository
    .filter((r) => r.repository?.owner?.login?.toLowerCase() !== LOGIN)
    .reduce((a, r) => a + r.contributions.totalCount, 0);

  console.log('REST: owned repositories ...');
  const owned = await fetchOwnedRepos();

  let ownedCommits365 = 0;
  let ownedCommits90 = 0;
  let reposWithCommits = new Set();
  let commitDates365 = [];
  const allTimeLangs = new Map();
  const recentWeighted = new Map(); // lang -> sum(share * commits90)
  let weightedCommits = 0;
  let additions365 = 0, deletions365 = 0;

  for (const repo of owned) {
    const commits = await fetchRepoCommits(repo, from365);
    const commits90 = commits.filter((c) => new Date(c.date) >= since90);
    if (commits.length) {
      reposWithCommits.add(repo.full_name);
      ownedCommits365 += commits.length;
      ownedCommits90 += commits90.length;
      commitDates365.push(...commits.map((c) => c.date));
    }

    const bytes = await fetchRepoLanguages(repo);
    const repoTotal = Object.values(bytes).reduce((a, b) => a + b, 0);
    for (const [lang, b] of Object.entries(bytes)) {
      if (!isProgramming(lang)) continue;
      allTimeLangs.set(lang, (allTimeLangs.get(lang) || 0) + b);
      if (repoTotal > 0 && commits90.length > 0) {
        recentWeighted.set(lang, (recentWeighted.get(lang) || 0) + (b / repoTotal) * commits90.length);
      }
    }
    if (repoTotal > 0 && commits90.length > 0) weightedCommits += commits90.length;

    const weeks = await fetchRepoStats(repo);
    if (weeks) {
      const s365 = sumStatsWeeks(weeks, new Date(from365).getTime());
      additions365 += s365.additions;
      deletions365 += s365.deletions;
    }
    await sleep(120); // be gentle with the API
  }

  const metrics = {
    generatedAt: fmtDate(now),
    timezone: TZ,
    scope: HAS_PRIVATE_ACCESS ? 'public+private' : 'public-only',
    user: viewer.login,
    overview: {
      // Commits authored in owned repos (public+private, non-merge) plus
      // public commit contributions in external repos.
      commits: ownedCommits365 + externalCommitTotal365,
      totalContributions: cc.contributionCalendar.totalContributions,
      activeDays,
      repositoriesTouched: reposWithCommits.size + externalRepoNames.size,
      additions: additions365,
      deletions: deletions365,
    },
    last90Days: {
      commits: ownedCommits90 + externalCommitTotal90,
      totalContributions: 0, // filled below
      activeDays: 0, // filled below
    },
    monthly: monthBuckets(days),
    calendar: days.map((d) => ({ date: d.date, count: d.contributionCount })),
    languages: {
      allTime: topLanguages(allTimeLangs),
      recent: weightedCommits > 0 ? topLanguages(recentWeighted) : [],
    },
    publicActivity: {
      commits: cc.totalCommitContributions,
      pullRequests: cc.totalPullRequestContributions,
      issues: cc.totalIssueContributions,
      reviews: cc.totalPullRequestReviewContributions,
      note: 'public repositories only (source: GitHub GraphQL)',
    },
    rhythm: { weekdayHour: weekdayHourMatrix(commitDates365) },
  };

  // 90d calendar slice for active days / contributions
  const d90 = days.filter((d) => new Date(`${d.date}T00:00:00Z`) >= since90);
  metrics.last90Days.totalContributions = d90.reduce((a, d) => a + d.contributionCount, 0);
  metrics.last90Days.activeDays = d90.filter((d) => d.contributionCount > 0).length;

  // Render light + dark SVGs
  const files = new Map();
  for (const [name, theme] of Object.entries(THEMES)) {
    files.set(`overview-${name}.svg`, renderOverview(metrics, theme));
    files.set(`trend-${name}.svg`, renderTrend(metrics, theme));
    files.set(`heatmap-${name}.svg`, renderHeatmap(metrics, theme));
    files.set(`languages-${name}.svg`, renderLanguages(metrics, theme));
  }

  // Privacy gate over everything that will be committed
  const repoNames = new Set(owned.map((r) => r.full_name));
  for (const n of externalRepoNames) repoNames.add(n);
  for (const r of cc.commitContributionsByRepository) {
    if (r.repository?.nameWithOwner) repoNames.add(r.repository.nameWithOwner);
  }
  const outputs = new Map(files);
  outputs.set('metrics.json', JSON.stringify(metrics, null, 2));
  assertNoRepoNames(outputs, repoNames);

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, content] of files) {
    await writeFile(new URL(name, OUT_DIR), content);
  }
  await writeFile(METRICS_JSON, JSON.stringify(metrics, null, 2));

  if (process.env.METRICS_CACHE === '1') {
    await mkdir(new URL('./cache/', import.meta.url), { recursive: true }).catch(() => {});
    await writeFile(CACHE, JSON.stringify({ data }, null, 2));
  }

  console.log(`OK scope=${metrics.scope}`);
  console.log(`365d: commits=${metrics.overview.commits} contributions=${metrics.overview.totalContributions} activeDays=${activeDays} repos=${metrics.overview.repositoriesTouched} +${additions365}/-${deletions365}`);
  console.log(`90d:  commits=${metrics.last90Days.commits} contributions=${metrics.last90Days.totalContributions} activeDays=${metrics.last90Days.activeDays}`);
  console.log(`languages all-time: ${metrics.languages.allTime.map((l) => `${l.name} ${l.percent}%`).join(', ')}`);
  console.log(`languages 90d:      ${metrics.languages.recent.map((l) => `${l.name} ${l.percent}%`).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
