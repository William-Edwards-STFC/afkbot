# afkbot

A Mineflayer-based AFK bot for `play.lostpiece.net`. Spawns multiple Microsoft-authenticated accounts, navigates through the hub server selector GUI, pathfinds to a designated AFK spot, and auto-reconnects on disconnect.

## Features

- Spawns multiple bots with staggered 60-second delays (time to authenticate each Microsoft account)
- Automatically clicks through the hub's server selector GUI
- Pathfinds to a configurable AFK coordinate
- Auto-reconnects after kicks/disconnects (30-second delay)
- Runtime pause/resume control via `paused.json` — no restart needed

## Requirements

- Node.js v18+
- A Microsoft account for each bot listed in `BOTS`

## Setup

```bash
npm install
```

## Usage

```bash
node bot.js
```

On first run each bot will open a browser window for Microsoft authentication. Subsequent runs use cached credentials.

## Configuration

Edit the constants at the top of `bot.js`:

| Constant | Description |
|---|---|
| `HUB_HOST` / `HUB_PORT` | Server address |
| `AFK_X/Y/Z` | Target AFK coordinates |
| `BOTS` | Array of `{ username, auth }` accounts |
| `BOT_SPAWN_DELAY` | Milliseconds between bot spawns (default 60s) |
| `SERVER_SELECT_SLOT` | Inventory slot of the server selector item in the hub GUI |

## Pausing / Resuming Bots

Edit `paused.json` while the script is running. The file is watched for changes — no restart required.

```json
["Alunewie", "Semi2412"]
```

You can also use 1-based index numbers instead of usernames:

```json
[1, 2]
```

- Adding a username pauses that bot (disconnects it and prevents reconnection).
- Removing a username resumes it (triggers an immediate reconnect).
