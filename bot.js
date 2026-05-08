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

const activeBotCount = new Gauge({ name: 'afkbot_active_bots_total',    help: 'Connected bots',          registers: [registry] });
const reconnectCount = new Counter({ name: 'afkbot_reconnects_total',   help: 'Reconnect attempts',      labelNames: ['username'], registers: [registry] });
const kickCount      = new Counter({ name: 'afkbot_kicks_total',         help: 'Kicks received',          labelNames: ['username'], registers: [registry] });
const rewardCount    = new Counter({ name: 'afkbot_daily_rewards_total', help: 'Daily rewards claimed',   labelNames: ['username'], registers: [registry] });

// ─── CONFIG ────────────────────────────────────────────────────────────────
const HUB_HOST = 'play.lostpiece.net';
const HUB_PORT = 25565;

const AFK_X = 165;
const AFK_Y = 82;
const AFK_Z = -1;

const AFK_GUI_TIMEOUT = 3 * 60 * 1000;

const BOTS = [
  { username: 'Alunewie',     auth: 'microsoft' },
  { username: 'Semi2412',     auth: 'microsoft' },
  { username: 'Babetr0n4497', auth: 'microsoft' },
  { username: 'Yogan1260',    auth: 'microsoft' },
  { username: 'henry979',     auth: 'microsoft' },
  { username: 'alt66',        auth: 'microsoft' },
  { username: 'alt77',        auth: 'microsoft' },
  { username: 'alt8',         auth: 'microsoft' },
  { username: 'alt9',         auth: 'microsoft' },
  { username: 'alt10',        auth: 'microsoft' },
  { username: 'alt11',        auth: 'microsoft' },
  { username: 'alt12',        auth: 'microsoft' },
  { username: 'alt13',        auth: 'microsoft' },
  { username: 'alt14',        auth: 'microsoft' },
  { username: 'alt15',        auth: 'microsoft' },
  { username: 'alt1',         auth: 'microsoft' },
];

// Initialise all counters to zero so every bot appears in charts even before first event
for (const acc of BOTS) {
  reconnectCount.inc({ username: acc.username }, 0);
  kickCount.inc({ username: acc.username }, 0);
  rewardCount.inc({ username: acc.username }, 0);
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

  const blog = log.child({ username: account.username });

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
    activeBots.delete(account.username);
    if (pausedBots.has(account.username)) {
      blog.info({ event: 'bot_disconnected', reason, paused: true }, 'Disconnected (paused) — will not reconnect');
    } else {
      blog.warn({ event: 'bot_disconnected', reason, paused: false, reconnect_in_ms: 30000 }, `Disconnected (${reason}) — reconnecting in 30s`);
      reconnectCount.inc({ username: account.username });
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

fs.watch(path.dirname(PAUSED_FILE), (eventType, filename) => {
  if (filename !== 'paused.json') return;
  applyPausedList(readPausedFile());
});
