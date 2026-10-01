// Appends one snapshot of every working prop source to a CSV. Run by GitHub Actions through scripts/push_data.sh.
import fs from "node:fs";
import { collectProps, csvLine, PROP_HEADER, shapes, pickLine, PICK_HEADER } from "../props.js";

const OUT = process.env.PROP_OUT || "props_log.csv";
const PICK_OUT = process.env.PICK_OUT || OUT.replace(/props_log\.csv$/, "pick_stats.csv");

async function loadPlayers() {
  const res = await fetch("https://api.sleeper.app/v1/players/nfl", { headers: { "User-Agent": "sleeper-mcp-logger/2.0" }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Sleeper players returned ${res.status}`);
  const raw = await res.json(); const P = {};
  for (const [id, p] of Object.entries(raw)) {
    P[id] = { name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id, pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "?", team: p.team || "" };
  }
  return P;
}

const P = await loadPlayers();
const ts = new Date().toISOString();
const { rows, status } = await collectProps(P);
for (const [k, v] of Object.entries(status)) console.log(`${k}: ${v.ok ? `${v.count} lines` : `FAILED - ${v.error}`}`);
if (Object.keys(shapes).length) console.log("raw fields seen:", JSON.stringify(shapes));

if (!Object.values(status).some((s) => s.ok)) { console.error("Every source failed. Nothing logged."); process.exit(2); }
if (!rows.length) { console.log("Sources responded but no NFL lines are posted right now. Nothing logged."); process.exit(0); }

if (!fs.existsSync(OUT) || fs.statSync(OUT).size === 0) fs.writeFileSync(OUT, PROP_HEADER + "\n");
fs.appendFileSync(OUT, rows.map((r) => csvLine(ts, r)).join("\n") + "\n");
console.log(`Appended ${rows.length} rows to ${OUT}`);
const picks = rows.filter((r) => r.pick_stats != null);
if (picks.length) {
  if (!fs.existsSync(PICK_OUT) || fs.statSync(PICK_OUT).size === 0) fs.writeFileSync(PICK_OUT, PICK_HEADER + "\n");
  fs.appendFileSync(PICK_OUT, picks.map((r) => pickLine(ts, r)).join("\n") + "\n");
  console.log(`Appended ${picks.length} pick_stats rows to ${PICK_OUT}`);
} else console.log("No pick_stats on this snapshot.");
