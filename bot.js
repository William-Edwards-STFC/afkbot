const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const pino = require('pino');
const { Registry, Gauge, Counter, collectDefaultMetrics } = require('prom-client');

const log = pino({ level: 'info' });

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const activeBotCount  = new Gauge({ name: 'afkbot_active_bots_total',     help: 'Connected bots',           registers: [registry] });
const botOnline       = new Gauge({ name: 'afkbot_bot_online',             help: 'Per-bot online status',    labelNames: ['username'], registers: [registry] });
const reconnectCount  = new Counter({ name: 'afkbot_reconnects_total',    help: 'Reconnect attempts',       labelNames: ['username'], registers: [registry] });
const kickCount       = new Counter({ name: 'afkbot_kicks_total',          help: 'Kicks received',           labelNames: ['username'], registers: [registry] });
const rewardCount     = new Counter({ name: 'afkbot_daily_rewards_total',    help: 'Daily rewards claimed',   labelNames: ['username'], registers: [registry] });
const uptimeSeconds   = new Counter({ name: 'afkbot_uptime_seconds_total',   help: 'Total seconds in AFK',    labelNames: ['username'], registers: [registry] });
const downtimeSeconds = new Counter({ name: 'afkbot_downtime_seconds_total', help: 'Total seconds offline',   labelNames: ['username'], registers: [registry] });

const disconnectTimes = new Map();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const HUB_HOST = 'play.lostpiece.net';
const HUB_PORT = 25565;

const AFK_X = 165;
const AFK_Y = 82;
const AFK_Z = -1;

const AFK_GUI_TIMEOUT = 3 * 60 * 1000;

const BOTS = [
  { username: 'Alunewie',     nickname: 'Alunewie',    auth: 'microsoft' },
  { username: 'Semi2412',     nickname: 'semi2412',    auth: 'microsoft' },
  { username: 'Babetr0n4497', nickname: 'Babetron',    auth: 'microsoft' },
  { username: 'Yogan1260',    nickname: 'yogan1260',   auth: 'microsoft' },
  { username: 'henry979',     nickname: 'henry979',    auth: 'microsoft' },
  { username: 'alt66',        nickname: 'v1perrex',    auth: 'microsoft' },
  { username: 'alt77',        nickname: 'Kulsts',      auth: 'microsoft' },
  { username: 'alt8',         nickname: 'oolonglebg',  auth: 'microsoft' },
  { username: 'alt9',         nickname: '8uuav',       auth: 'microsoft' },
  { username: 'alt10',        nickname: 'sznurek',     auth: 'microsoft' },
  { username: 'alt11',        nickname: 'fnaflol12',   auth: 'microsoft' },
  { username: 'alt12',        nickname: 'Aquilaurea',  auth: 'microsoft' },
  { username: 'alt13',        nickname: 'kfln',        auth: 'microsoft' },
  { username: 'alt14',        nickname: 'Mookra',      auth: 'microsoft' },
  { username: 'alt15',        nickname: 'Matuzali',    auth: 'microsoft' },
  { username: 'alt1',         nickname: 'painkakes',   auth: 'microsoft' },
];

// ─── PERSISTENT STATS ──────────────────────────────────────────────────────
const STATS_FILE = path.join(__dirname, 'stats.json');

const persistedStats = {};
for (const acc of BOTS) {
  persistedStats[acc.username] = { uptime: 0, downtime: 0, rewards: 0, reconnects: 0, kicks: 0 };
}

try {
  if (fs.existsSync(STATS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    for (const username of Object.keys(saved)) {
      if (persistedStats[username]) Object.assign(persistedStats[username], saved[username]);
    }
    log.info({ event: 'stats_loaded' }, 'Loaded persisted stats from disk');
  }
} catch (e) {
  log.error({ event: 'stats_load_error', err: e.message }, 'Failed to load stats.json — starting fresh');
}

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(persistedStats, null, 2));
  } catch (e) {
    log.error({ event: 'stats_save_error', err: e.message }, 'Failed to save stats.json');
  }
}

setInterval(saveStats, 5 * 60 * 1000);
process.on('SIGTERM', saveStats);
process.on('SIGINT', saveStats);

// Initialise all counters from persisted values so charts survive restarts
for (const acc of BOTS) {
  const s = persistedStats[acc.username];
  botOnline.set({ username: acc.username }, 0);
  reconnectCount.inc({ username: acc.username }, s.reconnects);
  kickCount.inc({ username: acc.username }, s.kicks);
  rewardCount.inc({ username: acc.username }, s.rewards);
  uptimeSeconds.inc({ username: acc.username }, s.uptime);
  downtimeSeconds.inc({ username: acc.username }, s.downtime);
}

const BOT_SPAWN_DELAY = 60000;

// ─── RUNTIME CONTROL ───────────────────────────────────────────────────────
const pausedBots = new Set();
const activeBots = new Map();

const SERVER_SELECT_SLOT = 22;
// ───────────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    activeBotCount.set(activeBots.size);
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } else { res.writeHead(404); res.end(); }
}).listen(9090, () => log.info({ event: 'metrics_server_started', port: 9090 }, 'Metrics listening on :9090'));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rawClick(client, windowId, slot) {
  client.write('window_click', {
    windowId,
    stateId: 1,
    slot,
    mouseButton: 0,
    mode: 0,
    changedSlots: [],
    cursorItem: { itemId: 0, itemCount: 0, components: [], removeComponents: [] },
  });
}

async function createBot(account) {
  if (pausedBots.has(account.username)) {
    log.info({ event: 'bot_skipped', username: account.username }, 'Bot is paused — skipping reconnect');
    return;
  }

  const blog = log.child({ username: account.username, nickname: account.nickname });

  const bot = mineflayer.createBot({
    host: HUB_HOST,
    port: HUB_PORT,
    username: account.username,
    auth: account.auth,
    version: '1.21.5',
  });

  bot.loadPlugin(pathfinder);
  activeBots.set(account.username, bot);

  // states: hub → selecting → server → navigating → afk
  let state = 'hub';
  let afkGuiWatchdog = null;
  let coinTimer = null;

  function setState(newState) {
    blog.info({ event: 'state_change', from: state, to: newState }, `State: ${state} → ${newState}`);
    state = newState;
  }

  function resetAfkGuiWatchdog() {
    clearTimeout(afkGuiWatchdog);
    afkGuiWatchdog = setTimeout(() => {
      blog.warn({ event: 'afk_gui_timeout', state, timeout_ms: AFK_GUI_TIMEOUT }, 'AFK GUI not detected — reconnecting');
      try { bot.quit('afk gui timeout'); } catch (_) {}
    }, AFK_GUI_TIMEOUT);
  }

  // ── Hub: right-click Game Selector item ─────────────────────────────────
  bot.on('spawn', async () => {
    if (state !== 'hub') return;
    blog.info({ event: 'hub_spawned', state }, 'Spawned on hub, settling');
    await sleep(2000);
    bot.setQuickBarSlot(0);
    await sleep(200);
    bot.activateItem();
    blog.info({ event: 'game_selector_clicked', state }, 'Right-clicked Game Selector, waiting for GUI');
    setState('selecting');
  });

  // ── Hub GUI: click server selector slot ─────────────────────────────────
  bot._client.on('open_window', async (packet) => {
    if (state === 'selecting') {
      blog.info({ event: 'server_gui_opened', windowId: packet.windowId, state }, 'Server selector GUI opened');
      await sleep(3000);
      setState('server');
      rawClick(bot._client, packet.windowId, SERVER_SELECT_SLOT);
      blog.info({ event: 'server_slot_clicked', slot: SERVER_SELECT_SLOT }, 'Clicked server slot, awaiting transfer');
      return;
    }

    if (state === 'afk') {
      blog.info({ event: 'afk_gui_detected', windowId: packet.windowId }, 'AFK reward GUI detected');
      resetAfkGuiWatchdog();
      rewardCount.inc({ username: account.username });
      persistedStats[account.username].rewards += 1;
      botOnline.set({ username: account.username }, 1);
      const disconnectedAt = disconnectTimes.get(account.username);
      if (disconnectedAt) {
        const secs = Math.round((Date.now() - disconnectedAt) / 1000);
        downtimeSeconds.inc({ username: account.username }, secs);
        persistedStats[account.username].downtime += secs;
        disconnectTimes.delete(account.username);
        blog.info({ event: 'downtime_recorded', seconds: secs }, `Downtime: ${secs}s`);
      }
    }
  });

  // ── Server transfer ──────────────────────────────────────────────────────
  bot._client.on('login', async () => {
    if (state !== 'server') return;
    setState('navigating');
    blog.info({ event: 'server_transfer', method: 'login' }, 'Transferred to target server, waiting for world load');
    await sleep(3000);
    bot.chat('/hub');
    blog.info({ event: 'hub_command_sent' }, 'Sent /hub, waiting to land');
    await sleep(3000);
    navigateToAFK();
  });

  // Fallback spawn-based transfer detection
  bot.on('spawn', async () => {
    if (state !== 'server') return;
    setState('navigating');
    blog.info({ event: 'server_transfer', method: 'spawn' }, 'Transferred to target server via spawn, waiting for world load');
    await sleep(3000);
    bot.chat('/hub');
    await sleep(3000);
    navigateToAFK();
  });

  // ── Pathfind to AFK spot ─────────────────────────────────────────────────
  function navigateToAFK() {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalBlock(AFK_X, AFK_Y, AFK_Z));
    blog.info({ event: 'pathfinding_started', target: { x: AFK_X, y: AFK_Y, z: AFK_Z } }, 'Pathfinding to AFK spot');

    bot.once('goal_reached', () => {
      setState('afk');
      bot.pathfinder.stop();
      blog.info({ event: 'afk_reached', x: AFK_X, y: AFK_Y, z: AFK_Z }, 'Reached AFK spot, standing by');
      resetAfkGuiWatchdog();

      coinTimer = setInterval(() => {
        uptimeSeconds.inc({ username: account.username }, 60);
        persistedStats[account.username].uptime += 60;
      }, 60 * 1000);
    });
  }

  // ── Error handling ───────────────────────────────────────────────────────
  bot.on('path_update', (r) => {
    if (r.status === 'noPath') {
      blog.warn({ event: 'no_path', target: { x: AFK_X, y: AFK_Y, z: AFK_Z } }, 'No path to AFK spot — check coordinates');
    }
  });

  bot._client.on('error', (err) => {
    blog.error({ event: 'client_error', err: err.message, state }, 'Client error — forcing reconnect');
    try { bot.quit('client error'); } catch (_) {}
  });

  // Watchdog: if the bot hasn't reached AFK state within 3 minutes, force a reconnect.
  const watchdog = setTimeout(() => {
    if (state !== 'afk') {
      blog.warn({ event: 'watchdog_triggered', state }, `Watchdog: stuck in state "${state}" after 3 min — forcing reconnect`);
      try { bot.quit('watchdog timeout'); } catch (_) {}
    }
  }, 3 * 60 * 1000);

  bot.on('kicked', (reason) => {
    kickCount.inc({ username: bot.username });
    persistedStats[account.username].kicks += 1;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      const text = parsed?.extra?.map(e => e.text ?? e).join('') ?? parsed?.text ?? JSON.stringify(parsed);
      blog.error({ event: 'kicked', reason: text, state }, `Kicked: ${text}`);
    } catch {
      blog.error({ event: 'kicked', reason: String(reason), state }, `Kicked: ${reason}`);
    }
  });

  bot.on('error', (err) => {
    blog.error({ event: 'bot_error', err: err.message, state }, `Bot error: ${err.message}`);
  });

  bot.on('end', (reason) => {
    clearTimeout(watchdog);
    clearTimeout(afkGuiWatchdog);
    clearInterval(coinTimer);
    botOnline.set({ username: account.username }, 0);
    disconnectTimes.set(account.username, Date.now());
    activeBots.delete(account.username);
    if (pausedBots.has(account.username)) {
      blog.info({ event: 'bot_disconnected', reason, paused: true }, 'Disconnected (paused) — will not reconnect');
    } else {
      blog.warn({ event: 'bot_disconnected', reason, paused: false, reconnect_in_ms: 30000 }, `Disconnected (${reason}) — reconnecting in 30s`);
      reconnectCount.inc({ username: account.username });
      persistedStats[account.username].reconnects += 1;
      setTimeout(() => createBot(account), 30000);
    }
  });
}

// ─── FILE-BASED CONTROL ─────────────────────────────────────────────────────
const PAUSED_FILE = path.join(__dirname, 'paused.json');

function resolveAlias(entry) {
  const n = parseInt(entry, 10);
  if (!isNaN(n) && n >= 1 && n <= BOTS.length) return BOTS[n - 1].username;
  return String(entry);
}

function readPausedFile() {
  try {
    if (!fs.existsSync(PAUSED_FILE)) return [];
    const raw = fs.readFileSync(PAUSED_FILE, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw).map(resolveAlias);
  } catch (e) {
    log.error({ event: 'control_file_error', err: e.message }, `Failed to parse paused.json: ${e.message}`);
    return [];
  }
}

function applyPausedList(newList) {
  const newSet = new Set(newList.map(u => u.toLowerCase()));

  for (const acc of BOTS) {
    const key = acc.username.toLowerCase();
    const wasPaused = pausedBots.has(acc.username);
    const isPaused  = newSet.has(key);

    if (!wasPaused && isPaused) {
      pausedBots.add(acc.username);
      const bot = activeBots.get(acc.username);
      if (bot) {
        try { bot.quit('paused by operator'); } catch (_) {
          try { bot._client.end('paused by operator'); } catch (_) {}
        }
        log.info({ event: 'bot_paused', username: acc.username }, 'Bot disconnected and paused');
      } else {
        log.info({ event: 'bot_paused', username: acc.username }, 'Bot marked as paused (not currently connected)');
      }
    } else if (wasPaused && !isPaused) {
      pausedBots.delete(acc.username);
      log.info({ event: 'bot_resumed', username: acc.username }, 'Bot resumed — reconnecting');
      createBot(acc);
    }
  }
}

applyPausedList(readPausedFile());

(async () => {
  for (let i = 0; i < BOTS.length; i++) {
    log.info({ event: 'bot_spawning', username: BOTS[i].username, index: i + 1, total: BOTS.length }, `Spawning bot ${i + 1}/${BOTS.length}: ${BOTS[i].username}`);
    createBot(BOTS[i]);
    if (i < BOTS.length - 1 && !pausedBots.has(BOTS[i].username)) await sleep(BOT_SPAWN_DELAY);
  }
})();

let lastPausedRaw = JSON.stringify(readPausedFile());
setInterval(() => {
  const current = readPausedFile();
  const raw = JSON.stringify(current);
  if (raw !== lastPausedRaw) {
    lastPausedRaw = raw;
    log.info({ event: 'paused_file_changed', list: current }, 'paused.json changed — applying');
    applyPausedList(current);
  }
}, 3000);
