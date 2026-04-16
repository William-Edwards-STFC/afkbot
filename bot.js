const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const HUB_HOST = 'play.lostpiece.net';
const HUB_PORT = 25565;

const AFK_X = 165;
const AFK_Y = 82;
const AFK_Z = -1;

const BOTS = [
  { username: 'Alunewie',    auth: 'microsoft' },
  { username: 'Semi2412',    auth: 'microsoft' },
  { username: 'Babetr0n4497', auth: 'microsoft' },
  { username: 'Yogan1260',   auth: 'microsoft' },
];

const BOT_SPAWN_DELAY = 60000; // 60 seconds between bots — enough time to auth each Microsoft account

// ─── RUNTIME CONTROL ───────────────────────────────────────────────────────
const pausedBots = new Set();       // usernames that should NOT auto-reconnect
const activeBots = new Map();       // username → bot instance

// Hub GUI: row 3, col 5 → slot 22
const SERVER_SELECT_SLOT = 22;
// ───────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Write a raw window_click packet (1.21.5 HashedSlot format)
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
    console.log(`[${account.username}] Is paused — skipping reconnect.`);
    return;
  }

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

  // ── Hub: right-click Game Selector item ─────────────────────────────────
  bot.on('spawn', async () => {
    if (state !== 'hub') return;
    console.log(`[${bot.username}] Spawned on hub, settling...`);
    await sleep(2000);
    bot.setQuickBarSlot(0);
    await sleep(200);
    bot.activateItem();
    console.log(`[${bot.username}] Right-clicked Game Selector, waiting for GUI...`);
    state = 'selecting';
  });

  // ── Hub GUI: click server selector slot ─────────────────────────────────
  bot._client.on('open_window', async (packet) => {
    if (state === 'selecting') {
      console.log(`[${bot.username}] Server selector GUI opened (windowId=${packet.windowId})`);
      await sleep(3000);
      state = 'server';
      rawClick(bot._client, packet.windowId, SERVER_SELECT_SLOT);
      console.log(`[${bot.username}] Clicked slot ${SERVER_SELECT_SLOT}, awaiting transfer...`);
      return;
    }

    if (state === 'afk') {
      console.log(`[${bot.username}] AFK reward GUI detected (windowId=${packet.windowId})`);
    }
  });

  // ── Server transfer ──────────────────────────────────────────────────────
  bot._client.on('login', async () => {
    if (state !== 'server') return;
    state = 'navigating';
    console.log(`[${bot.username}] Transferred to target server, waiting for world load...`);
    await sleep(3000);
    bot.chat('/hub');
    console.log(`[${bot.username}] Sent /hub, waiting to land...`);
    await sleep(3000);
    navigateToAFK();
  });

  // Fallback spawn-based transfer detection
  bot.on('spawn', async () => {
    if (state !== 'server') return;
    state = 'navigating';
    console.log(`[${bot.username}] Transferred to target server (spawn), waiting for world load...`);
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
    console.log(`[${bot.username}] Pathfinding to AFK spot (${AFK_X}, ${AFK_Y}, ${AFK_Z})...`);

    bot.once('goal_reached', () => {
      state = 'afk';
      bot.pathfinder.stop();
      console.log(`[${bot.username}] Reached AFK spot. Standing by.`);
    });
  }

  // ── Error handling ───────────────────────────────────────────────────────
  bot.on('path_update', (r) => {
    if (r.status === 'noPath') console.warn(`[${bot.username}] No path to AFK spot — check coordinates.`);
  });

  bot.on('kicked', (reason) => console.error(`[${bot.username}] Kicked: ${reason}`));
  bot.on('error',  (err)    => console.error(`[${bot.username}] Error: ${err.message}`));
  bot.on('end',    (reason) => {
    activeBots.delete(account.username);
    if (pausedBots.has(account.username)) {
      console.log(`[${bot.username}] Disconnected (paused) — will not reconnect until resumed.`);
    } else {
      console.log(`[${bot.username}] Disconnected (${reason}) — reconnecting in 30s...`);
      setTimeout(() => createBot(account), 30000);
    }
  });
}

(async () => {
  for (let i = 0; i < BOTS.length; i++) {
    console.log(`Spawning bot ${i + 1}/${BOTS.length}: ${BOTS[i].username}`);
    createBot(BOTS[i]);
    if (i < BOTS.length - 1) await sleep(BOT_SPAWN_DELAY);
  }
})();

// ─── FILE-BASED CONTROL ─────────────────────────────────────────────────────
// Edit paused.json to pause/resume bots at runtime:
//   Add a username    → bot disconnects and stops reconnecting
//   Remove a username → bot reconnects automatically
//
// Example paused.json:
//   ["Alunewie", "Semi2412"]
//
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
    console.error(`[control] Failed to parse paused.json: ${e.message}`);
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
      // Newly paused — disconnect
      pausedBots.add(acc.username);
      const bot = activeBots.get(acc.username);
      if (bot) {
        bot.quit('paused by operator');
        console.log(`[${acc.username}] Disconnected and paused.`);
      } else {
        console.log(`[${acc.username}] Marked as paused (will not reconnect).`);
      }
    } else if (wasPaused && !isPaused) {
      // Newly resumed — reconnect
      pausedBots.delete(acc.username);
      console.log(`[${acc.username}] Resuming...`);
      createBot(acc);
    }
  }
}

// Load initial state
applyPausedList(readPausedFile());

// Watch for changes
fs.watch(path.dirname(PAUSED_FILE), (eventType, filename) => {
  if (filename !== 'paused.json') return;
  applyPausedList(readPausedFile());
});
