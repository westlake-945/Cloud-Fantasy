// Sleeper Fantasy MCP server
// Exposes a Sleeper league (public, read-only API) as MCP tools over Streamable HTTP.
// Zero dependencies. Node 18+.

import http from "node:http";
import fs from "node:fs";
import { collectProps, impliedPPR, csvLine, PROP_HEADER } from "./props.js";

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_LEAGUE = process.env.LEAGUE_ID || "";
const MY_TEAM = (process.env.MY_TEAM || "").trim(); // your Sleeper display name or team name
const MCP_PATH = process.env.MCP_PATH || "/mcp";   // set to something unguessable, e.g. /mcp-8f3k2...
const API = "https://api.sleeper.app/v1";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// Sleeper API helpers
// ---------------------------------------------------------------------------
const cache = new Map();

async function sleeper(path, ttlMs = 60_000) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.data;
  const res = await fetch(API + path, { headers: { "User-Agent": "sleeper-mcp/1.0" } });
  if (!res.ok) throw new Error(`Sleeper API returned ${res.status} for ${path}`);
  const data = await res.json();
  cache.set(path, { data, exp: Date.now() + ttlMs });
  return data;
}

// Sleeper asks that the full player dump (~5 MB) be fetched at most once a day.
let players = null;
let playersLoadedAt = 0;
let playersLoading = null;

async function getPlayers() {
  if (players && Date.now() - playersLoadedAt < 24 * 3600_000) return players;
  if (!playersLoading) {
    playersLoading = (async () => {
      try {
        const res = await fetch(`${API}/players/nfl`, { headers: { "User-Agent": "sleeper-mcp/1.0" } });
        if (!res.ok) throw new Error(`Sleeper API returned ${res.status} for /players/nfl`);
        const raw = await res.json();
        const slim = {};
        for (const [id, p] of Object.entries(raw)) {
          const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
          slim[id] = {
            name,
            key: normalize(name),
            pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "?",
            team: p.team || null,
            inj: p.injury_status || null,
            age: p.age ?? null,
            exp: p.years_exp ?? null,
            rank: p.search_rank ?? 1e9,
            active: p.active !== false,
            gsis: p.gsis_id ? String(p.gsis_id).trim() : null,
          };
        }
        players = slim;
        playersLoadedAt = Date.now();
        console.log(`Loaded ${Object.keys(slim).length} players`);
      } catch (e) {
        if (!players) throw e; // keep serving yesterday's data if refresh fails
        console.error("Player refresh failed, using cached copy:", e.message);
      }
      return players;
    })().finally(() => { playersLoading = null; });
  }
  return playersLoading;
}

const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function fmtPlayer(P, id) {
  const p = P[id];
  if (!p) return `Unknown player #${id}`;
  const bits = [p.pos, p.team || "FA"];
  if (p.inj) bits.push(p.inj);
  return `${p.name} (${bits.join(", ")})`;
}

const pts = (s, k) => (s?.[k] ?? 0) + (s?.[`${k}_decimal`] ?? 0) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

async function nflState() {
  return sleeper("/state/nfl", 10 * 60_000);
}

async function leagueCtx(leagueId) {
  const id = String(leagueId || DEFAULT_LEAGUE || "").trim();
  if (!id) throw new Error("No league_id given and the LEAGUE_ID environment variable is not set.");
  const [league, users, rosters] = await Promise.all([
    sleeper(`/league/${id}`, 3600_000),
    sleeper(`/league/${id}/users`, 3600_000),
    sleeper(`/league/${id}/rosters`, 60_000),
  ]);
  if (!league) throw new Error(`League ${id} not found on Sleeper.`);
  const userById = Object.fromEntries((users || []).map((u) => [u.user_id, u]));
  const teams = (rosters || []).map((r) => {
    const u = userById[r.owner_id];
    const owner = u?.display_name || "Unowned";
    return {
      roster_id: r.roster_id,
      owner,
      team_name: u?.metadata?.team_name || owner,
      roster: r,
    };
  });
  const byRoster = Object.fromEntries(teams.map((t) => [t.roster_id, t]));
  return { id, league, teams, byRoster };
}

function findTeam(ctx, q) {
  const s = String(q ?? "").toLowerCase().trim();
  if (!s) return null;
  return (
    ctx.teams.find((t) => String(t.roster_id) === s) ||
    ctx.teams.find((t) => t.owner.toLowerCase() === s || t.team_name.toLowerCase() === s) ||
    ctx.teams.find((t) => t.owner.toLowerCase().includes(s) || t.team_name.toLowerCase().includes(s)) ||
    null
  );
}

const teamLabel = (t) => (t ? `${t.team_name}${t.team_name !== t.owner ? ` [${t.owner}]` : ""}` : "Unknown team");
const isMine = (t) => MY_TEAM && t && (t.owner.toLowerCase() === MY_TEAM.toLowerCase() || t.team_name.toLowerCase() === MY_TEAM.toLowerCase());

function rosteredMap(ctx) {
  const m = {};
  for (const t of ctx.teams) {
    const r = t.roster;
    for (const pid of [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]) m[pid] = t;
  }
  return m;
}

const FLEX_EXPANSION = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

function leaguePositions(league) {
  const set = new Set();
  for (const slot of league.roster_positions || []) {
    if (slot === "BN") continue;
    (FLEX_EXPANSION[slot] || [slot]).forEach((p) => set.add(p));
  }
  return set;
}

async function resolveWeek(week) {
  if (week) return Number(week);
  const s = await nflState();
  return Number(s.display_week ?? s.week ?? 1);
}


// ---------------------------------------------------------------------------
// Projections & stats (undocumented Sleeper endpoints — parsed defensively)
// ---------------------------------------------------------------------------
const SKILL = ["QB", "RB", "WR", "TE"];
async function sleeperRaw(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.data;
  const res = await fetch(url, { headers: { "User-Agent": "sleeper-mcp/1.1" } });
  if (!res.ok) throw new Error(`Sleeper returned ${res.status} for ${url}`);
  const data = await res.json();
  cache.set(url, { data, exp: Date.now() + ttlMs });
  return data;
}
// Returns Map(player_id -> { ppr, half, std, stats })
function normalizeWeekly(data) {
  const out = new Map();
  const add = (pid, st) => {
    if (!pid || !st) return;
    const ppr = st.pts_ppr ?? (st.pts_std != null ? st.pts_std + (st.rec || 0) : null);
    if (ppr == null) return;
    out.set(String(pid), { ppr: +ppr, half: st.pts_half_ppr ?? null, std: st.pts_std ?? null, stats: st });
  };
  if (Array.isArray(data)) for (const r of data) add(r.player_id, r.stats || r);
  else if (data && typeof data === "object") for (const [pid, st] of Object.entries(data)) add(pid, st);
  return out;
}
async function weekly(kind, season, week, ttlMs) {
  const pos = SKILL.map((p) => `position[]=${p}`).join("&");
  const urls = [
    `https://api.sleeper.app/${kind}/nfl/${season}/${week}?season_type=regular&${pos}`,
    `https://api.sleeper.app/v1/${kind}/nfl/regular/${season}/${week}`,
  ];
  let lastErr;
  for (const u of urls) {
    try {
      const m = normalizeWeekly(await sleeperRaw(u, ttlMs));
      if (m.size) return m;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not read Sleeper ${kind} for ${season} week ${week}` + (lastErr ? `: ${lastErr.message}` : " (format may have changed)"));
}


// ---------------------------------------------------------------------------
// ESPN projections (undocumented fantasy API — parsed defensively)
// ---------------------------------------------------------------------------
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE" };
async function espnWeek(season, week) {
  const key = `espn:${season}:${week}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const filter = { players: { filterSlotIds: { value: [0, 2, 4, 6] }, limit: 600, offset: 0,
    sortPercOwned: { sortAsc: false, sortPriority: 1 },
    filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`01${season}${week}`, `11${season}${week}`, `00${season}`, `10${season}`] } } };
  const hosts = ["https://lm-api-reads.fantasy.espn.com", "https://fantasy.espn.com"];
  let lastErr;
  for (const h of hosts) {
    try {
      const url = `${h}/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`;
      const res = await fetch(url, { headers: { "X-Fantasy-Filter": JSON.stringify(filter), Accept: "application/json", "User-Agent": "Mozilla/5.0 sleeper-mcp/1.2" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
      const j = await res.json();
      const out = [];
      for (const it of j.players || []) {
        const p = it.player || it; const pos = ESPN_POS[p.defaultPositionId]; if (!pos) continue;
        let proj = null, act = null;
        for (const st of p.stats || []) {
          if (st.scoringPeriodId !== Number(week) || st.statSplitTypeId !== 1) continue;
          if (st.statSourceId === 1) proj = st.appliedTotal;
          if (st.statSourceId === 0) act = st.appliedTotal;
        }
        if (proj == null) continue;
        out.push({ name: p.fullName, pos, espnId: p.id, proj: +proj, act: act == null ? null : +act });
      }
      if (!out.length) throw new Error("no projections in response (format may have changed)");
      cache.set(key, { data: out, exp: Date.now() + 6 * 3600_000 });
      return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`ESPN ${season} week ${week}: ${lastErr?.message}`);
}


// ---------------------------------------------------------------------------
// Player props (live lookups). Long-term history is logged by the GitHub Actions job (see scripts/log_props.mjs);
// set PROP_LOG=off in the cloud so the server never writes to its (temporary) disk.
// ---------------------------------------------------------------------------
const PROP_FILE = process.env.PROP_LOG || "./props_log.csv";
const PROP_WRITE = PROP_FILE.toLowerCase() !== "off";
const PROP_HOURS = Number(process.env.PROP_LOG_HOURS || 0);
const propState = { last: {}, rows: 0 };
async function snapshotProps() {
  const P = await getPlayers(); const ts = new Date().toISOString(); const result = {};
  const { rows, status } = await collectProps(P);
  for (const [name, st] of Object.entries(status)) {
    if (st.ok) { const mine = rows.filter((r) => r.provider === name); propState.last[name] = { ts, ok: true, count: mine.length, rows: mine }; propState.rows += mine.length; result[name] = `${mine.length} lines`; }
    else { propState.last[name] = { ts, ok: false, error: st.error }; result[name] = `failed (${st.error})`; }
  }
  if (PROP_WRITE && rows.length) {
    if (!fs.existsSync(PROP_FILE)) fs.writeFileSync(PROP_FILE, PROP_HEADER + "\n");
    fs.appendFileSync(PROP_FILE, rows.map((r) => csvLine(ts, r)).join("\n") + "\n");
  }
  return result;
}
if (PROP_HOURS > 0) {
  setTimeout(() => snapshotProps().then((r) => console.log("prop snapshot", r)).catch(() => {}), 15000);
  setInterval(() => snapshotProps().then((r) => console.log("prop snapshot", r)).catch(() => {}), PROP_HOURS * 3600_000);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const leagueIdProp = {
  league_id: { type: "string", description: "Sleeper league ID. Optional; defaults to the configured league." },
};

const TOOLS = [

  {
    name: "get_props",
    description: "Latest player prop lines (Sleeper Picks / PrizePicks / Underdog) for a player or a fantasy team's roster, plus a prop-implied PPR score. Takes a fresh snapshot if none is under 2 hours old.",
    inputSchema: { type: "object", properties: {
      player: { type: "string", description: "Player name (partial ok). Optional." },
      team: { type: "string", description: "Fantasy team (roster ID, owner or team name). Defaults to your team if no player given." },
      ...leagueIdProp } },
    async handler({ player, team, league_id }) {
      const fresh = Object.values(propState.last).some((v) => v.ok && Date.now() - Date.parse(v.ts) < 2 * 3600_000);
      if (!fresh) await snapshotProps();
      const P = await getPlayers(); let want;
      if (player) want = new Set([normalize(player)]);
      else { const ctx = await leagueCtx(league_id); const t = findTeam(ctx, team || MY_TEAM); if (!t) return "Team not found."; want = new Set([...(t.roster.players || [])].map((pid) => P[pid]?.key).filter(Boolean)); }
      const by = {};
      for (const [prov, st] of Object.entries(propState.last)) {
        if (!st.ok) continue;
        for (const r of st.rows) {
          const k = normalize(r.player); if (![...want].some((w) => k === w || (player && k.includes(w)))) continue;
          by[r.player] ||= {}; by[r.player][r.stat] ||= {}; by[r.player][r.stat][prov] = r.line;
        }
      }
      const names = Object.keys(by); if (!names.length) return "No prop lines found for those players yet (lines usually post midweek).";
      return names.map((n) => {
        const consensus = {}; for (const [stat, v] of Object.entries(by[n])) { const xs = Object.values(v); consensus[stat] = xs.reduce((a, b) => a + b, 0) / xs.length; }
        const imp = impliedPPR(consensus);
        const lines = Object.entries(by[n]).map(([stat, v]) => `  ${stat}: ${Object.entries(v).map(([p, l]) => `${p} ${l}`).join(" | ")}`);
        return `${n}${imp ? ` — prop-implied ≈ ${imp.pts.toFixed(1)} PPR (from ${imp.used.join(", ")}; excludes TDs unless a TD line exists)` : ""}\n${lines.join("\n")}`;
      }).join("\n\n");
    },
  },
  {
    name: "props_status",
    description: "Prop logger health: which sources work, lines captured in the latest snapshot, total rows logged, and the log file location.",
    inputSchema: { type: "object", properties: { snapshot_now: { type: "boolean", description: "Take a fresh snapshot first." } } },
    async handler({ snapshot_now }) {
      if (snapshot_now) await snapshotProps();
      let head;
      if (PROP_WRITE) { let size = 0, lines = 0; try { const t = fs.readFileSync(PROP_FILE, "utf8"); size = t.length; lines = Math.max(0, t.split("\n").length - 2); } catch {} head = `Local prop log: ${PROP_FILE} — ${lines} rows (${(size / 1024).toFixed(0)} KB). Auto-snapshot every ${PROP_HOURS}h.`; }
      else head = "Cloud mode: this server only fetches live lines on request. The history is logged every 6 hours by the GitHub Actions job to the repo's `data` branch (props_log.csv).";
      const src = Object.entries(propState.last).map(([k, v]) => `- ${k}: ${v.ok ? `OK, ${v.count} lines at ${v.ts}` : `FAILED at ${v.ts} — ${v.error}`}`);
      return [head, ...(src.length ? src : ["- no live snapshot yet (call with snapshot_now=true)"])].join("\n");
    },
  },

  {
    name: "get_espn_projections",
    description: "ESPN's weekly PPR fantasy projections for QB/RB/WR/TE, marked with who rosters each player in the league (matched by name).",
    inputSchema: { type: "object", properties: {
      week: { type: "integer", description: "NFL week. Defaults to current." }, season: { type: "string", description: "Season. Defaults to current." },
      position: { type: "string", description: "QB, RB, WR or TE. Optional." }, only_available: { type: "boolean", description: "Only unrostered players." },
      limit: { type: "integer", description: "Max players. Default 40." }, ...leagueIdProp } },
    async handler({ week, season, position, only_available = false, limit = 40, league_id }) {
      const st = await nflState(); const wk = Number(week || st.display_week || st.week); const yr = String(season || st.season);
      const [ctx, P, rows0] = await Promise.all([leagueCtx(league_id), getPlayers(), espnWeek(yr, wk)]);
      const owned = rosteredMap(ctx); const byName = {};
      for (const [pid, t] of Object.entries(owned)) { const p = P[pid]; if (p) byName[`${p.key}|${p.pos}`] = t; }
      let rows = rows0.map((r) => ({ ...r, owner: byName[`${normalize(r.name)}|${r.pos}`] }));
      if (position) rows = rows.filter((r) => r.pos === String(position).toUpperCase());
      if (only_available) rows = rows.filter((r) => !r.owner);
      rows.sort((a, b) => b.proj - a.proj);
      return [`ESPN projections — ${yr} week ${wk} (PPR)`, ...rows.slice(0, Number(limit)).map((r, i) => `${i + 1}. ${r.name} (${r.pos}) — ${r.proj.toFixed(1)} pts — ${r.owner ? `on ${teamLabel(r.owner)}` : "AVAILABLE"}`)].join("\n");
    },
  },

  {
    name: "list_my_leagues",
    description: "List all of the user's Sleeper leagues for a season, with league IDs.",
    inputSchema: { type: "object", properties: { season: { type: "string", description: "Season year. Defaults to current." } } },
    async handler({ season }) {
      if (!MY_TEAM) throw new Error("Set MY_TEAM to your Sleeper username.");
      const s = season || (await nflState()).season;
      const user = await sleeper(`/user/${encodeURIComponent(MY_TEAM)}`, 3600_000);
      if (!user) throw new Error(`Sleeper user ${MY_TEAM} not found.`);
      const leagues = await sleeper(`/user/${user.user_id}/leagues/nfl/${s}`, 3600_000);
      if (!leagues?.length) return `No leagues found for ${s}.`;
      return leagues.map((l) => `${l.name} — id ${l.league_id} (${l.total_rosters} teams, ${l.status})`).join("\n");
    },
  },
  {
    name: "get_projections",
    description: "Sleeper's weekly fantasy projections (PPR, half, standard) for QB/RB/WR/TE, marked with who rosters each player in the league. Filter by position, team (roster ID/owner/team name), or availability.",
    inputSchema: {
      type: "object",
      properties: {
        week: { type: "integer", description: "NFL week. Defaults to the current week." },
        season: { type: "string", description: "Season year. Defaults to current." },
        position: { type: "string", description: "QB, RB, WR or TE. Optional." },
        team: { type: "string", description: "Only this fantasy team's players (roster ID, owner or team name). Optional." },
        only_available: { type: "boolean", description: "Only unrostered players. Default false." },
        limit: { type: "integer", description: "Max players. Default 40." },
        ...leagueIdProp,
      },
    },
    async handler({ week, season, position, team, only_available = false, limit = 40, league_id }) {
      const st = await nflState();
      const wk = Number(week || st.display_week || st.week); const yr = String(season || st.season);
      const [ctx, P, proj] = await Promise.all([leagueCtx(league_id), getPlayers(), weekly("projections", yr, wk, 30 * 60_000)]);
      const owned = rosteredMap(ctx);
      const ft = team ? findTeam(ctx, team) : null;
      if (team && !ft) return `Team not found: ${team}`;
      let rows = [...proj.entries()].map(([pid, v]) => ({ pid, ...v, p: P[pid] })).filter((r) => r.p && SKILL.includes(r.p.pos));
      if (position) rows = rows.filter((r) => r.p.pos === String(position).toUpperCase());
      if (ft) rows = rows.filter((r) => owned[r.pid]?.roster_id === ft.roster_id);
      if (only_available) rows = rows.filter((r) => !owned[r.pid]);
      rows.sort((a, b) => b.ppr - a.ppr);
      const fmt = ctx.league.scoring_settings?.rec ?? 1;
      return [
        `Sleeper projections — ${yr} week ${wk} (league scoring: ${fmt} PPR)`,
        ...rows.slice(0, Number(limit)).map((r, i) => {
          const pts = fmt >= 1 ? r.ppr : fmt >= 0.5 ? (r.half ?? r.ppr) : (r.std ?? r.ppr);
          return `${i + 1}. ${fmtPlayer(P, r.pid)} — ${(+pts).toFixed(1)} pts — ${owned[r.pid] ? `on ${teamLabel(owned[r.pid])}` : "AVAILABLE"}`;
        }),
      ].join("\n");
    },
  },
  {
    name: "get_league_info",
    description: "League settings: name, scoring (PPR value), roster slots, waiver type, playoff/trade-deadline weeks, current NFL week, and the list of teams.",
    inputSchema: { type: "object", properties: { ...leagueIdProp } },
    async handler({ league_id }) {
      const [ctx, state] = await Promise.all([leagueCtx(league_id), nflState()]);
      const L = ctx.league;
      const s = L.settings || {};
      const waiverTypes = { 0: "rolling (claiming sends you to the back)", 1: "reverse standings", 2: "FAAB bidding" };
      const lines = [
        `${L.name} (${L.season}, status: ${L.status})`,
        `NFL: season ${state.season}, week ${state.display_week ?? state.week} (${state.season_type})`,
        `Teams: ${ctx.teams.length}`,
        `Scoring: ${L.scoring_settings?.rec ?? 0} pts per reception, ${L.scoring_settings?.pass_td ?? "?"} per pass TD`,
        `Starting slots: ${(L.roster_positions || []).filter((p) => p !== "BN").join(", ")}`,
        `Bench: ${(L.roster_positions || []).filter((p) => p === "BN").length}, IR: ${s.reserve_slots ?? 0}`,
        `Waivers: ${waiverTypes[s.waiver_type] ?? `type ${s.waiver_type}`}${s.waiver_type === 2 ? `, budget $${s.waiver_budget}` : ""}`,
        `Trade deadline week: ${s.trade_deadline ?? "?"}, playoffs start week: ${s.playoff_week_start ?? "?"}, playoff teams: ${s.playoff_teams ?? "?"}`,
        "",
        "Teams:",
        ...ctx.teams.map((t) => `- roster ${t.roster_id}: ${teamLabel(t)}${isMine(t) ? "  <- YOU" : ""}`),
      ];
      return lines.join("\n");
    },
  },
  {
    name: "get_standings",
    description: "Standings with record, points for/against, max possible points (best-lineup points), lineup efficiency, and waiver position for every team.",
    inputSchema: { type: "object", properties: { ...leagueIdProp } },
    async handler({ league_id }) {
      const ctx = await leagueCtx(league_id);
      const rows = ctx.teams.map((t) => {
        const s = t.roster.settings || {};
        const pf = pts(s, "fpts"), pa = pts(s, "fpts_against"), max = pts(s, "ppts");
        return { t, w: s.wins || 0, l: s.losses || 0, tie: s.ties || 0, pf, pa, max, eff: max ? pf / max : 0, wp: s.waiver_position };
      });
      rows.sort((a, b) => b.w - a.w || b.pf - a.pf);
      return [
        "Rank | Team | W-L-T | PF | PA | Max PF | Efficiency | Waiver #",
        ...rows.map((r, i) =>
          `${i + 1}. ${teamLabel(r.t)}${isMine(r.t) ? " <- YOU" : ""} | ${r.w}-${r.l}-${r.tie} | ${round1(r.pf)} | ${round1(r.pa)} | ${round1(r.max)} | ${(r.eff * 100).toFixed(1)}% | ${r.wp ?? "-"}`
        ),
      ].join("\n");
    },
  },
  {
    name: "get_roster",
    description: "One team's roster with player names, positions, NFL teams and injury status, split into starters (by slot), bench, IR and taxi. Defaults to the user's own team if configured.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Roster ID, owner display name, or team name. Optional if MY_TEAM is configured." },
        ...leagueIdProp,
      },
    },
    async handler({ team, league_id }) {
      const [ctx, P] = await Promise.all([leagueCtx(league_id), getPlayers()]);
      const t = findTeam(ctx, team || MY_TEAM);
      if (!t) return `Team not found. Teams: ${ctx.teams.map((x) => `${x.roster_id}=${teamLabel(x)}`).join("; ")}`;
      const r = t.roster;
      const slots = (ctx.league.roster_positions || []).filter((p) => p !== "BN");
      const starters = r.starters || [];
      const reserve = new Set(r.reserve || []);
      const taxi = new Set(r.taxi || []);
      const startSet = new Set(starters);
      const bench = (r.players || []).filter((p) => !startSet.has(p) && !reserve.has(p) && !taxi.has(p));
      const s = r.settings || {};
      const lines = [
        `${teamLabel(t)} (roster ${t.roster_id}) — ${s.wins || 0}-${s.losses || 0}${s.ties ? `-${s.ties}` : ""}, ${round1(pts(s, "fpts"))} PF`,
        "Starters:",
        ...starters.map((pid, i) => `- ${slots[i] || "?"}: ${pid === "0" ? "EMPTY" : fmtPlayer(P, pid)}`),
        "Bench:",
        ...(bench.length ? bench.map((pid) => `- ${fmtPlayer(P, pid)}`) : ["- (none)"]),
      ];
      if (reserve.size) lines.push("IR:", ...[...reserve].map((pid) => `- ${fmtPlayer(P, pid)}`));
      if (taxi.size) lines.push("Taxi:", ...[...taxi].map((pid) => `- ${fmtPlayer(P, pid)}`));
      return lines.join("\n");
    },
  },
  {
    name: "get_matchups",
    description: "Head-to-head matchups and scores for a week. Optionally include per-player starter points for one team.",
    inputSchema: {
      type: "object",
      properties: {
        week: { type: "integer", description: "NFL week. Defaults to the current week." },
        detail_team: { type: "string", description: "Optional team (roster ID, owner or team name) to break down starter-by-starter." },
        ...leagueIdProp,
      },
    },
    async handler({ week, detail_team, league_id }) {
      const wk = await resolveWeek(week);
      const ctx = await leagueCtx(league_id);
      const data = await sleeper(`/league/${ctx.id}/matchups/${wk}`, 60_000);
      if (!data?.length) return `No matchup data for week ${wk}.`;
      const groups = {};
      for (const m of data) (groups[m.matchup_id ?? `bye-${m.roster_id}`] ||= []).push(m);
      const lines = [`Week ${wk} matchups:`];
      for (const g of Object.values(groups)) {
        lines.push(g.map((m) => `${teamLabel(ctx.byRoster[m.roster_id])} ${round1(m.points ?? 0)}`).join("  vs  "));
      }
      if (detail_team) {
        const t = findTeam(ctx, detail_team);
        const m = t && data.find((x) => x.roster_id === t.roster_id);
        if (m) {
          const P = await getPlayers();
          const slots = (ctx.league.roster_positions || []).filter((p) => p !== "BN");
          lines.push("", `${teamLabel(t)} starters, week ${wk}:`);
          (m.starters || []).forEach((pid, i) =>
            lines.push(`- ${slots[i] || "?"}: ${pid === "0" ? "EMPTY" : fmtPlayer(P, pid)} — ${round1(m.starters_points?.[i] ?? 0)}`)
          );
          const benchPts = Object.entries(m.players_points || {})
            .filter(([pid]) => !(m.starters || []).includes(pid))
            .sort((a, b) => b[1] - a[1]);
          if (benchPts.length) lines.push("Bench:", ...benchPts.map(([pid, v]) => `- ${fmtPlayer(P, pid)} — ${round1(v)}`));
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "get_transactions",
    description: "Waiver claims, free-agent pickups, drops and trades for a given week (Sleeper calls these 'rounds'), with player and team names.",
    inputSchema: {
      type: "object",
      properties: {
        week: { type: "integer", description: "Week/round. Defaults to the current week." },
        include_failed: { type: "boolean", description: "Include failed waiver claims (default false)." },
        ...leagueIdProp,
      },
    },
    async handler({ week, include_failed = false, league_id }) {
      const wk = await resolveWeek(week);
      const ctx = await leagueCtx(league_id);
      const [P, tx] = await Promise.all([getPlayers(), sleeper(`/league/${ctx.id}/transactions/${wk}`, 60_000)]);
      const list = (tx || []).filter((t) => include_failed || t.status === "complete").sort((a, b) => (b.created || 0) - (a.created || 0));
      if (!list.length) return `No ${include_failed ? "" : "completed "}transactions in week ${wk}.`;
      const lines = [`Week ${wk} transactions (${list.length}):`];
      for (const t of list) {
        const date = t.created ? new Date(t.created).toISOString().slice(0, 10) : "?";
        const head = `[${date}] ${t.type.toUpperCase().replace("_", " ")}${t.status !== "complete" ? ` (${t.status})` : ""}`;
        if (t.type === "trade") {
          const gets = {};
          for (const [pid, rid] of Object.entries(t.adds || {})) (gets[rid] ||= []).push(fmtPlayer(P, pid));
          for (const pk of t.draft_picks || []) (gets[pk.owner_id] ||= []).push(`${pk.season} round ${pk.round} pick (orig. ${teamLabel(ctx.byRoster[pk.roster_id])})`);
          lines.push(head, ...Object.entries(gets).map(([rid, items]) => `  ${teamLabel(ctx.byRoster[rid])} gets: ${items.join(", ")}`));
        } else {
          const rid = (t.roster_ids || [])[0];
          const adds = Object.keys(t.adds || {}).map((pid) => `+${fmtPlayer(P, pid)}`);
          const drops = Object.keys(t.drops || {}).map((pid) => `-${fmtPlayer(P, pid)}`);
          const bid = t.settings?.waiver_bid != null ? ` ($${t.settings.waiver_bid})` : "";
          lines.push(`${head} — ${teamLabel(ctx.byRoster[rid])}: ${[...adds, ...drops].join(" / ")}${bid}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "get_trending_players",
    description: "Players trending on Sleeper (most added or dropped across all leagues), marked with whether they are available in this league.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["add", "drop"], description: "Trending adds or drops. Default add." },
        lookback_hours: { type: "integer", description: "Window in hours. Default 24." },
        limit: { type: "integer", description: "How many players. Default 25." },
        only_available: { type: "boolean", description: "Only show players not rostered in this league. Default false." },
        ...leagueIdProp,
      },
    },
    async handler({ type = "add", lookback_hours = 24, limit = 25, only_available = false, league_id }) {
      const [ctx, P, trend] = await Promise.all([
        leagueCtx(league_id),
        getPlayers(),
        sleeper(`/players/nfl/trending/${type}?lookback_hours=${Number(lookback_hours)}&limit=${Math.min(Number(limit) * 3, 100)}`, 15 * 60_000),
      ]);
      const owned = rosteredMap(ctx);
      const rows = (trend || [])
        .map((x) => ({ ...x, owner: owned[x.player_id] }))
        .filter((x) => !only_available || !x.owner)
        .slice(0, Number(limit));
      return [
        `Trending ${type}s, last ${lookback_hours}h:`,
        ...rows.map((x, i) => `${i + 1}. ${fmtPlayer(P, x.player_id)} — ${x.count} ${type}s — ${x.owner ? `on ${teamLabel(x.owner)}` : "AVAILABLE"}`),
      ].join("\n");
    },
  },
  {
    name: "get_free_agents",
    description: "Best available (unrostered) players in this league, ordered by Sleeper's relevance rank. Filter by position.",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "string", description: "QB, RB, WR, TE, K, DEF (or IDP positions). Optional." },
        limit: { type: "integer", description: "How many players. Default 25." },
        ...leagueIdProp,
      },
    },
    async handler({ position, limit = 25, league_id }) {
      const [ctx, P] = await Promise.all([leagueCtx(league_id), getPlayers()]);
      const owned = rosteredMap(ctx);
      const allowed = position ? new Set([String(position).toUpperCase()]) : leaguePositions(ctx.league);
      const rows = Object.entries(P)
        .filter(([id, p]) => !owned[id] && p.active && p.team && allowed.has(p.pos))
        .sort((a, b) => a[1].rank - b[1].rank)
        .slice(0, Number(limit));
      if (!rows.length) return "No available players found for that filter.";
      return [
        `Best available${position ? ` ${String(position).toUpperCase()}` : ""}:`,
        ...rows.map(([id, p], i) => `${i + 1}. ${fmtPlayer(P, id)}${p.age ? `, age ${p.age}` : ""}`),
      ].join("\n");
    },
  },
  {
    name: "find_player",
    description: "Look up players by name: position, NFL team, injury status, age, experience, Sleeper ID, and which team in this league rosters them.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Full or partial player name." }, ...leagueIdProp },
      required: ["name"],
    },
    async handler({ name, league_id }) {
      const [ctx, P] = await Promise.all([leagueCtx(league_id), getPlayers()]);
      const q = normalize(name || "");
      if (!q) return "Give a player name.";
      const owned = rosteredMap(ctx);
      const hits = Object.entries(P)
        .filter(([, p]) => p.key.includes(q))
        .sort((a, b) => a[1].rank - b[1].rank)
        .slice(0, 10);
      if (!hits.length) return `No players matching "${name}".`;
      return hits
        .map(([id, p]) =>
          `${fmtPlayer(P, id)} — id ${id}${p.age ? `, age ${p.age}` : ""}${p.exp != null ? `, ${p.exp} yrs exp` : ""} — ${owned[id] ? `on ${teamLabel(owned[id])}` : "AVAILABLE"}`
        )
        .join("\n");
    },
  },
];

// ---------------------------------------------------------------------------
// MCP JSON-RPC over Streamable HTTP (stateless, JSON responses)
// ---------------------------------------------------------------------------
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg?.id, -32600, "Invalid Request");
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === undefined) return null; // a response from the client; nothing to do
  if (isNotification) return null;       // notifications/initialized, cancelled, etc.

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : FALLBACK_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "sleeper-fantasy", version: "2.0.0" },
            instructions:
              "Read-only access to a Sleeper fantasy football league. Start with get_standings or get_league_info to see teams" +
              (MY_TEAM ? `; the user's team is "${MY_TEAM}" (marked YOU).` : "; ask the user which team is theirs.") +
              " Player data comes from Sleeper and refreshes daily; injury statuses may lag breaking news.",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ handler, ...t }) => t) } };
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const text = await tool.handler(params.arguments || {});
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } };
        }
      }
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("sleeper-mcp is running"); }
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (url.pathname === `${MCP_PATH}/export/projections.csv` && req.method === "GET") {
    try {
      const seasons = (url.searchParams.get("seasons") || "2023,2024,2025").split(",").map((x) => x.trim()).filter(Boolean);
      const w0 = Number(url.searchParams.get("from") || 1), w1 = Number(url.searchParams.get("to") || 18);
      const P = await getPlayers();
      const lines = ["season,week,sleeper_id,gsis_id,name,position,team,proj_ppr,actual_ppr"];
      const problems = [];
      for (const yr of seasons) {
        for (let wk = w0; wk <= w1; wk++) {
          let proj, act;
          try { proj = await weekly("projections", yr, wk, 24 * 3600_000); } catch (e) { problems.push(e.message); continue; }
          try { act = await weekly("stats", yr, wk, 24 * 3600_000); } catch (e) { act = new Map(); problems.push(e.message); }
          for (const [pid, v] of proj) {
            const p = P[pid];
            if (!p || !SKILL.includes(p.pos)) continue;
            const a = act.get(pid);
            const name = String(p.name).replace(/[",]/g, " ");
            lines.push([yr, wk, pid, p.gsis || "", name, p.pos, p.team || "", v.ppr.toFixed(2), a ? a.ppr.toFixed(2) : ""].join(","));
          }
          await new Promise((r) => setTimeout(r, 150)); // be polite to Sleeper
        }
      }
      if (problems.length) lines.push(`# ${problems.length} week(s) had problems: ${problems.slice(0, 3).join(" | ").replace(/,/g, ";")}`);
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=sleeper_projections.csv" });
      return res.end(lines.join("\n"));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Export failed: " + e.message);
    }
  }

  if (url.pathname === `${MCP_PATH}/export/espn.csv` && req.method === "GET") {
    const seasons = (url.searchParams.get("seasons") || "2023,2024,2025").split(",").map((x) => x.trim()).filter(Boolean);
    const w0 = Number(url.searchParams.get("from") || 1), w1 = Number(url.searchParams.get("to") || 18);
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=espn_projections.csv" });
    res.write("season,week,espn_id,name,position,proj_ppr,actual_ppr\n");   // stream so the tunnel never times out
    const problems = [];
    for (const yr of seasons) for (let wk = w0; wk <= w1; wk++) {
      try { const rows = await espnWeek(yr, wk); res.write(rows.map((r) => [yr, wk, r.espnId, String(r.name).replace(/[",]/g, " "), r.pos, r.proj.toFixed(2), r.act == null ? "" : r.act.toFixed(2)].join(",")).join("\n") + "\n"); }
      catch (e) { problems.push(e.message); }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (problems.length) res.write(`# ${problems.length} week(s) had problems: ${problems.slice(0, 3).join(" | ").replace(/,/g, ";")}\n`);
    return res.end();
  }

  if (url.pathname === `${MCP_PATH}/export/props.csv` && req.method === "GET") {
    if (!PROP_WRITE) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Cloud mode: the prop history lives in your GitHub repo, on the `data` branch (props_log.csv)."); }
    try { const t = fs.readFileSync(PROP_FILE, "utf8"); res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=props_log.csv" }); return res.end(t); }
    catch { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("No prop log yet."); }
  }
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404);
    return res.end();
  }
  if (req.method !== "POST") {
    // No server-initiated SSE stream; spec allows 405 here.
    res.writeHead(405, { Allow: "POST" });
    return res.end();
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      res.writeHead(413);
      return res.end();
    }
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
  }

  const batch = Array.isArray(payload);
  const replies = (await Promise.all((batch ? payload : [payload]).map(handleRpc))).filter(Boolean);

  if (!replies.length) {
    res.writeHead(202);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(batch ? replies : replies[0]));
});

server.listen(PORT, () => {
  console.log(`Sleeper MCP v2.0 listening on :${PORT} (path ${MCP_PATH.slice(0, 9)}…, league ${DEFAULT_LEAGUE || "none"}, node ${process.version})`);
  getPlayers().catch((e) => console.error("Initial player load failed:", e.message));
});

export { server, TOOLS, handleRpc };
