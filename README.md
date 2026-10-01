# Sleeper MCP — cloud version

Gives Claude live access to your Sleeper league (rosters, projections, props). Runs on Render, logs prop lines with GitHub Actions. No PC needed.

## 1. Put the code on GitHub
1. github.com -> **New repository** -> name `sleeper-mcp` -> **Private** -> Create.
2. Extract this zip. On the new repo page click **uploading an existing file**, then drag **everything inside the extracted folder** onto the page (include the `.github` and `scripts` folders). Click **Commit changes**.
3. Check the repo shows: `.github`, `scripts`, `.gitignore`, `.env.example`, `package.json`, `props.js`, `render.yaml`, `server.js`.

## 2. Deploy on Render (free)
1. render.com -> sign up with GitHub -> **New** -> **Blueprint** -> pick `sleeper-mcp`.
2. Render reads `render.yaml` and asks for three values:
   - `LEAGUE_ID` = 1400662150640340992
   - `MY_TEAM` = sloppyslobster
   - `MCP_PATH` = /mcp- plus a random GUID (PowerShell: `[guid]::NewGuid()`)
3. Apply. When it says Live, open `https://YOUR-SERVICE.onrender.com/health` — it should say `ok`.

## 3. Keep it awake (free tier sleeps after 15 min idle)
uptimerobot.com (free) -> **Add monitor** -> HTTP(s) -> URL `https://YOUR-SERVICE.onrender.com/health` -> every 5 minutes.

## 4. Connect Claude
Claude -> Settings -> Connectors -> remove the old tunnel connector -> **Add custom connector**:
`https://YOUR-SERVICE.onrender.com/` + your MCP_PATH (for example `https://sleeper-mcp-abcd.onrender.com/mcp-1234...`).
Start a new chat and ask: "props status".

## 5. Start the prop logger
Repo -> **Actions** tab -> (click "I understand my workflows, go ahead and enable them" if asked) -> **log-props** -> **Run workflow**.
Open the run and read the log: it lists which sources worked. History is saved to the repo's **`data` branch** (`props_log.csv`), which never triggers a redeploy. It then runs every 6 hours by itself.

## 6. Shut down the old setup
Close the local server and tunnel windows. The AIFantasy folder on your PC is no longer needed.

## Troubleshooting
- First request after a long idle is slow (cold start) — the UptimeRobot ping prevents this.
- Render "Deploy failed": open Logs and send me the last 20 lines.
- Actions run is red: that means every prop source failed; open the log and send me the first 15 lines.
- Never paste passwords or tokens into chat.
