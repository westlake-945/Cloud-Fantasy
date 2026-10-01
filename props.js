// Shared prop-line code. Used by server.js (live lookups) and scripts/log_props.mjs (GitHub Actions logger).
// Sources (Sleeper Picks, PrizePicks, Underdog) are undocumented endpoints, parsed defensively;
// any one of them can fail without affecting the others.

export const PROP_HEADER = "ts,provider,player,position,team,stat,line,over_mult";

const STAT_MAP = [
  [/^(pass(ing)?[ _]?y(ar)?ds|passing yards)$/i, "pass_yds"],
  [/^(rush(ing)?[ _]?y(ar)?ds|rushing yards)$/i, "rush_yds"],
  [/^(rec(eiving)?[ _]?y(ar)?ds|receiving yards)$/i, "rec_yds"],
  [/^(receptions|rec)$/i, "receptions"],
  [/^(rush(ing)?[ _]?att(empt)?s?|rush attempts)$/i, "rush_att"],
  [/^(pass(ing)?[ _]?att(empt)?s?|pass attempts)$/i, "pass_att"],
  [/^(pass(ing)?[ _]?(td|touchdowns)s?|pass tds)$/i, "pass_td"],
  // combined yardage markets ("rushing and receiving yards", "rushing + receiving yards", "rush+rec yds")
  [/^rush(ing)?\s*(\+|and|&)\s*rec(eiving)?\s*y(ar)?ds$/i, "rush_rec_yds"],
  [/^pass(ing)?\s*(\+|and|&)\s*rush(ing)?\s*y(ar)?ds$/i, "pass_rush_yds"],
  [/^(fantasy[ _]?(points|score)|fantasy_points)$/i, "fantasy_pts"],
];
export const normStat = (x) => {
  const t = String(x || "").trim().replace(/_/g, " ");
  for (const [re, k] of STAT_MAP) if (re.test(t)) return k;
  return t.toLowerCase().replace(/\s+/g, "_");
};

async function getJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 sleeper-mcp/2.0", Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Raw field names seen on the first record of each source — printed by the logger so we can see what Sleeper exposes.
export const shapes = {};
const num = (v) => (v == null || v === "" || isNaN(+v) ? "" : +v);

export const PROVIDERS = {
  async sleeper(P) {
    const j = await getJSON("https://api.sleeper.app/lines/available?dynamic=true&include_preseason=false&eg=15.control");
    const arr = Array.isArray(j) ? j : j.lines || j.data || [];
    const out = [];
    for (const r of arr) {
      if (r.sport && String(r.sport).toLowerCase() !== "nfl") continue;
      const pid = String(r.subject_id ?? r.player_id ?? ""); const p = P[pid];
      const stat = normStat(r.wager_type ?? r.stat_type ?? r.market);
      let line = r.line ?? r.value, mult = r.payout_multiplier ?? r.multiplier ?? null;
      if (Array.isArray(r.options) && r.options.length) {
        const over = r.options.find((o) => /over|higher/i.test(o.outcome || "")) || r.options[0];
        if (line == null) line = over?.outcome_value;
        mult = over?.payout_multiplier ?? over?.multiplier ?? over?.odds ?? mult;
        if (!shapes.sleeper_option) shapes.sleeper_option = Object.keys(over || {});
      }
      if (!shapes.sleeper_line) shapes.sleeper_line = Object.keys(r);
      if (!p || line == null || isNaN(+line)) continue;
      out.push({ player: p.name, position: p.pos, team: p.team || "", stat, line: +line, over_mult: num(mult) });
    }
    return out;
  },
  async prizepicks() {
    const j = await getJSON("https://api.prizepicks.com/projections?league_id=9&per_page=1000&single_stat=true");
    const players = {}; for (const inc of j.included || []) if (/player/.test(inc.type)) players[inc.id] = inc.attributes || {};
    const out = [];
    for (const d of j.data || []) {
      const a = d.attributes || {}; if (a.odds_type && a.odds_type !== "standard") continue;
      const pid = d.relationships?.new_player?.data?.id ?? d.relationships?.player?.data?.id; const pl = players[pid];
      if (!pl || a.line_score == null) continue;
      out.push({ player: pl.name || pl.display_name, position: pl.position || "", team: pl.team || pl.team_name || "", stat: normStat(a.stat_type), line: +a.line_score, over_mult: "" });
    }
    return out;
  },
  async underdog() {
    const j = await getJSON("https://api.underdogfantasy.com/beta/v5/over_under_lines");
    const players = {}; for (const p of j.players || []) players[p.id] = p;
    const apps = {}; for (const a of j.appearances || []) apps[a.id] = a;
    const out = [];
    for (const l of j.over_under_lines || []) {
      const st = l.over_under?.appearance_stat; const app = apps[st?.appearance_id]; const pl = app && players[app.player_id];
      if (!pl || (pl.sport_id && pl.sport_id !== "NFL") || l.stat_value == null) continue;
      out.push({ player: `${pl.first_name} ${pl.last_name}`.trim(), position: pl.position_name || "", team: "", stat: normStat(st.display_stat || st.stat), line: +l.stat_value, over_mult: "" });
    }
    return out;
  },
};

// Runs every source; one failing never blocks the others.
export async function collectProps(P) {
  const rows = [], status = {};
  for (const [name, fn] of Object.entries(PROVIDERS)) {
    try {
      const got = (await fn(P)).filter((r) => ["QB", "RB", "WR", "TE"].includes(String(r.position).toUpperCase()) || !r.position);
      for (const r of got) rows.push({ provider: name, ...r });
      status[name] = { ok: true, count: got.length };
    } catch (e) { status[name] = { ok: false, error: e.message }; }
  }
  return { rows, status };
}

export const csvLine = (ts, r) =>
  [ts, r.provider, String(r.player).replace(/[",]/g, " "), r.position, r.team, r.stat, r.line, r.over_mult ?? ""].join(",");

// prop-implied PPR (receptions + yards/10 + pass yds/25 + pass TD*4 - INT*2). Anytime-TD lines are not included.
export function impliedPPR(lines) {
  const g = (k) => lines[k]; let pts = 0; const used = [];
  if (g("receptions") != null) { pts += g("receptions"); used.push("rec"); }
  if (g("rush_rec_yds") != null) { pts += g("rush_rec_yds") / 10; used.push("rush+rec yds"); }
  else { if (g("rec_yds") != null) { pts += g("rec_yds") / 10; used.push("rec yds"); } if (g("rush_yds") != null) { pts += g("rush_yds") / 10; used.push("rush yds"); } }
  if (g("pass_yds") != null) { pts += g("pass_yds") / 25; used.push("pass yds"); }
  if (g("pass_td") != null) { pts += g("pass_td") * 4; used.push("pass TD"); }
  if (g("interceptions") != null && g("pass_yds") != null) { pts -= g("interceptions") * 2; used.push("INT"); }
  return used.length ? { pts, used } : null;
}
