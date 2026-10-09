// yukaichou.com watchdog — every 5 minutes from GitHub Actions.
//
// Why: on 2026-10-09 the site's Kinsta container froze for 16 minutes (Cloudflare 522/523,
// nginx silent) and only came back after a PHP restart through the Kinsta API. Nobody was
// watching; it was found by chance. This finds it within ~5 minutes and does the same restart.
//
//   1. Probe the site past every cache (a cache-busting query string), plus the origin's own
//      kinsta.cloud address. Up to 3 rounds, 40 s apart. Any 2xx/3xx = healthy, stop.
//   2. Still down after 3 rounds: restart PHP via the Kinsta API, unless a restart already
//      happened in the last 30 minutes (read from Kinsta's activity log, so state needs no store).
//   3. Open (or update) a GitHub issue labelled "outage", which emails the repo owner. When a
//      later run finds the site healthy, it comments and closes the issue.
//
// Without the KINSTA_API_KEY secret it still detects and alerts; it just can't restart.
// DRY_RUN=1 never restarts. Node 20+, no dependencies.

const SITE = process.env.WATCHDOG_SITE || 'https://yukaichou.com/';   // overrides exist for testing the down path
const ORIGIN = process.env.WATCHDOG_ORIGIN || 'https://yukaichoucom.kinsta.cloud/';
const KINSTA = 'https://api.kinsta.com/v2';
const { KINSTA_API_KEY, KINSTA_ENV_ID, KINSTA_COMPANY_ID, GITHUB_TOKEN, GITHUB_REPOSITORY, DRY_RUN } = process.env;
const COOLDOWN_MS = 30 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'yukaichou-watchdog/1.0 (+https://github.com/' + (GITHUB_REPOSITORY || 'fdlink/yukaichou-watchdog') + ')';

async function probe(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25e3);
  const t0 = Date.now();
  try {
    const r = await fetch(url + '?watchdog=' + Date.now(), { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': UA } });
    return { url, status: r.status, ms: Date.now() - t0, ok: r.status >= 200 && r.status < 400 };
  } catch (e) {
    return { url, status: 0, ms: Date.now() - t0, ok: false, error: e.name };
  } finally { clearTimeout(timer); }
}

async function kinsta(path, init = {}) {
  const r = await fetch(KINSTA + path, { ...init, headers: { Authorization: 'Bearer ' + KINSTA_API_KEY, 'Content-Type': 'application/json' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function lastRestartAgeMs() {
  const { status, body } = await kinsta(`/company/${KINSTA_COMPANY_ID}/activity-logs?limit=30`);
  if (status !== 200) { return null; }
  const items = body?.company?.activity_logs?.items || [];
  const hit = items.find(a => a.type === 'restartPhpEngine');
  return hit ? Date.now() - hit.created_at : Infinity;
}

async function restart() {
  const { status, body } = await kinsta('/sites/tools/restart-php', { method: 'POST', body: JSON.stringify({ environment_id: KINSTA_ENV_ID }) });
  if (!body?.operation_id) { return `restart request failed (${status}: ${JSON.stringify(body)})`; }
  for (let i = 0; i < 36; i++) {          // up to 6 minutes; on 2026-10-09 it took ~6
    await sleep(10e3);
    const op = await kinsta('/operations/' + encodeURIComponent(body.operation_id));
    if (op.status !== 202) { return `restart operation finished (${op.status}: ${op.body?.message || ''})`; }
  }
  return 'restart still in progress after 6 minutes';
}

async function gh(path, init = {}) {
  const r = await fetch('https://api.github.com/repos/' + GITHUB_REPOSITORY + path, { ...init, headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  return r.json().catch(() => null);
}
const openOutage = async () => ((await gh('/issues?state=open&labels=outage')) || [])[0] || null;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const table = rounds => rounds.map((r, i) => `round ${i + 1}: ` + r.map(p => `${p.url} → ${p.status || p.error} in ${p.ms} ms`).join(' · ')).join('\n');

const rounds = [];
for (let i = 0; i < 3; i++) {
  if (i) { await sleep(40e3); }
  const res = await Promise.all([probe(SITE), probe(ORIGIN)]);
  rounds.push(res);
  if (res.some(p => p.ok)) { break; }
}
const healthy = rounds.at(-1).some(p => p.ok);
console.log(table(rounds));

if (healthy) {
  const issue = GITHUB_TOKEN && await openOutage();
  if (issue) {
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `✅ Back up at ${stamp()}.\n\n\`\`\`\n${table(rounds)}\n\`\`\`` }) });
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
  process.exit(0);
}

let action = 'No restart: KINSTA_API_KEY is not set, so this run can only alert.';
if (KINSTA_API_KEY && KINSTA_ENV_ID && KINSTA_COMPANY_ID) {
  const age = await lastRestartAgeMs();
  if (DRY_RUN === '1') { action = 'DRY RUN: would restart PHP now.'; }
  else if (age !== null && age < COOLDOWN_MS) { action = `No restart: one already ran ${Math.round(age / 60e3)} min ago (cooldown 30 min). A person needs to look.`; }
  else {
    action = 'Restarted PHP through the Kinsta API: ' + await restart();
    await sleep(20e3);
    const after = await Promise.all([probe(SITE), probe(ORIGIN)]);
    action += '\nAfter restart: ' + after.map(p => `${p.url} → ${p.status || p.error}`).join(' · ');
  }
}
console.log(action);

if (GITHUB_TOKEN) {
  const body = `🔴 yukaichou.com did not answer at ${stamp()}.\n\n\`\`\`\n${table(rounds)}\n\`\`\`\n\n${action}\n\nRun: ${process.env.GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issue = await openOutage();
  if (issue) { await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) }); }
  else { await gh('/issues', { method: 'POST', body: JSON.stringify({ title: `yukaichou.com down — ${stamp()}`, body, labels: ['outage'] }) }); }
}
process.exit(1);   // a red run in the Actions tab too
