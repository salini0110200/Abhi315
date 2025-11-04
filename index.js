// clean_bot_full.js
const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// === GLOBAL STATE ===
let botAPI = null;
let adminID = null;
let prefix = '/';
let botNickname = 'LEGEND PRINCE';
let lockedGroups = {};       // threadID -> title
let lockedNicknames = {};    // threadID -> nickname
let lockedTargets = {};      // threadID -> targetUserID (string)
let currentCookies = null;
let reconnectAttempt = 0;
let conversationState = {}; // threadID -> stage

// Track last message to avoid spam replies
let lastMessageTime = {}; // threadID -> timestamp

const signature = `\n\n— 💕𝑴𝑹 𝑷𝑹𝑰𝑵𝑪𝑬 💕`;
const separator = `\n------------------------------`;

// === MASTI AUTO REPLY ===
const mastiReplies = [
  "TER1 BEHEN K1 CHOOT KO MUJHE CHODNE ME B4D4 M4Z4 4RH4 H41 BEHENCHOD KE D1NNE K1N4R K1 4UL44D HEHEHEHEH <3😆",
  "TER1 TER1 BEHEN K1 CHOOT TO K4L4P K4L4P KE LOWD4 CHUSE J44 RH1 H41 HEN HEN BEHENCHOD KE D1NNE =]]😂",
  "44J4 BEHCOD KE LOWDE TER1 BEHEN K1 CHOOT KO M41 CHOD J4UNG4 LOWDE KE B44L R4ND1 KE D1NNE =]]😎",
  "TER1 BEHEN K1 CHOOT =]] F4T1 J44 RH1 H41 BHOSD KE B| TER1 BEHEN K1 CHOOT 1TN4 K4L4P K1YO RH1 H41 REEE R4ND1 KE B4CHEW =]]😜",
  "TER1 BEHEN KE BHOSDE ME M41 LOWD4 D44L KR TER1 BEHEN K1 CHOOT KO M41 CHOD J4UNG4 LOWDE KE B4CHEW 44J4 BEHCOD KE LOWDE =]]🤣",
  "TER1 B44J1 K1 CHOOT ME M41 SUNEH4R1 LOWDE KE 4T4KDEER L4G4 DUNG4 R44ND KE B4CHEW K1 TER1 BEHEN K1 BOOR K4PTE T4B4H1G1 LOWDE <3🔥",
  "TER1 BEHEN K1 CHOOT KO M41 CHOD M4RU BEHENCHOD KE LOWDE R4ND1 KE D1NNE =]]💕",
  "TER1 BEHEN K1 G44ND ME M41 LOWD4 M4RUNG4 BHOSD CHOD KE 4UL44D S4LE G4NDE N44L1 KE G4NDE B4CHEW BHOSDKE =]]😏",
  "M41 TER1 M44 KO K41SE CHODT4 HUN 44J TUJHE Y44D D1L4 DUNG4 R444ND KE B4CHEW :v 44J M41 TUJHE RUL RUL4 KE CHODUNG4 BEHHNCHOD KE D1NNE :v😂",
  "MERE B4CHEW 44J4 MERE LOWDE _||_ PE JHOOM M4THERCHOD KE GH4ST1 KE B4CHEW <3 TER1 BEHEN K1 CHOOT ME M41 B4ST1 B4S4 DU :v🤭",
  "4J4 =]] REG1ST44N KE D1NNE TER1 BEHEN K1 G44ND M4RU LOWDE KE D1NNE B|😁",
  "R4ND1 1NSH44N KE R4ND1 B4CHEW TER1 BEHEN K1 CHOOT KO M41 CHODTE J4UNG4 LOWDE KE D1NNE TER1 BEHEN K1 G44ND KO M41 CHEER J4U =]] 😘"
];

// === LOG SYSTEM ===
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? 'ERROR: ' : 'INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveConfig() {
  try {
    const toSave = {
      botNickname,
      cookies: currentCookies || null,
      adminID,
      prefix,
      lockedGroups,
      lockedNicknames,
      lockedTargets
    };
    fs.writeFileSync('config.json', JSON.stringify(toSave, null, 2));
    emitLog('Configuration saved.');
  } catch (e) {
    emitLog('Failed to save config: ' + e.message, true);
  }
}

// === BOT INIT ===
function initializeBot(cookies, prefixArg, adminArg) {
  emitLog('Initializing bot...');
  currentCookies = cookies;
  if (prefixArg) prefix = prefixArg;
  if (adminArg) adminID = adminArg;
  reconnectAttempt = 0;

  login({ appState: currentCookies }, (err, api) => {
    if (err) {
      emitLog(`Login error: ${err.message}. Retrying in 10s.`, true);
      setTimeout(() => initializeBot(currentCookies, prefix, adminID), 10000);
      return;
    }

    emitLog('Bot logged in successfully.');
    botAPI = api;
    botAPI.setOptions({ selfListen: true, listenEvents: true, updatePresence: false });

    setTimeout(async () => {
      try { await setBotNicknamesInGroups(); } catch (e) { emitLog('Error restoring nicknames: ' + e.message, true); }
      startListening(api);
    }, 2000);

    setInterval(saveConfig, 5 * 60 * 1000);
  });
}

// === RECONNECT SYSTEM ===
function reconnectAndListen() {
  reconnectAttempt++;
  emitLog(`Reconnect attempt #${reconnectAttempt}...`);
  if (botAPI) {
    try { botAPI.stopListening(); } catch {}
  }

  if (reconnectAttempt > 5) {
    emitLog('Max reconnect attempts reached; reinitializing login.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) startListening(botAPI);
      else initializeBot(currentCookies, prefix, adminID);
    }, 5000);
  }
}

// === LISTENER ===
function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog('Listener error: ' + err.message, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      }
    } catch (e) {
      emitLog('Handler crashed: ' + e.message, true);
    }
  });
}

// === FORMAT MESSAGE (TAG SYSTEM) ===
async function formatMessage(api, event, mainText) {
  const { senderID, threadID } = event;
  let senderName = 'User';

  try {
    const info = await api.getUserInfo(senderID);
    senderName = info?.[senderID]?.name || null;

    // Fix if "Facebook User"
    if (!senderName || senderName.toLowerCase().includes('facebook user')) {
      const thread = await api.getThreadInfo(threadID);
      const user = thread.userInfo.find(u => u.id === senderID);
      senderName = user?.name || `User-${senderID}`;
    }
  } catch {
    senderName = `User-${senderID}`;
  }

  return {
    body: `@${senderName} ${mainText}\n\n— 💕𝑴𝑹 𝑷𝑹𝑰𝑵𝑪𝑬 💕\n------------------------------`,
    mentions: [{ tag: `@${senderName}`, id: senderID }]
  };
}

// === MESSAGE HANDLER ===
async function handleMessage(api, event) {
  const { threadID, senderID, body } = event;
  if (!body) return;
  const msg = body.toLowerCase();

  // Ignore messages from the bot itself
  const botID = api.getCurrentUserID && api.getCurrentUserID();
  if (senderID === botID) return;

  // === TARGET LOCK: if a target is set for this thread, ignore others (except admin commands) ===
  const target = lockedTargets[threadID];
  const isAdmin = senderID === adminID;
  const isCommand = body.startsWith(prefix);

  if (target) {
    // NEW BEHAVIOR:
    // - If sender is the target => allow (normal replies)
    // - If sender is admin AND is issuing a command => allow (commands only)
    // - Otherwise => ignore (admin's normal messages will be ignored)
    if (senderID === target) {
      // allowed: proceed
    } else if (isAdmin && isCommand) {
      // admin commands allowed
    } else {
      // all others ignored (including admin non-command messages)
      if (isCommand && !isAdmin) {
        // Non-admin trying to use commands while target is locked -> deny
        await api.sendMessage({ body: `You don't have permission to use commands while target is locked.`, mentions: [] }, threadID);
      }
      return;
    }
  }

  // Avoid multiple replies in quick succession (spam stop)
  const now = Date.now();
  if (lastMessageTime[threadID] && now - lastMessageTime[threadID] < 1500) return;
  lastMessageTime[threadID] = now;

  // === Normal conversation ===
  if (!conversationState[threadID]) conversationState[threadID] = 0;

  // If it's a command and sender is admin -> handle commands
  if (isCommand) {
    // only admin can run commands
    if (!isAdmin) {
      return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);
    }

    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Command routing
    if (command === 'group') return handleGroupCommand(api, event, args, isAdmin);
    if (command === 'nickname') return handleNicknameCommand(api, event, args, isAdmin);
    if (command === 'target') return handleTargetCommand(api, event, args, isAdmin);

    const help = await formatMessage(api, event, `‎═══════════════════
𝐠𝐫𝐨𝐮𝐩 𝐨𝐧/𝐨𝐟𝐟 → 𝐋𝐎𝐂𝐊 𝐆𝐑𝐎𝐔𝐏 𝐍𝐀𝐌𝐄
𝐧𝐢𝐜𝐤𝐧𝐚𝐦𝐞 𝐨𝐧/𝐨𝐟𝐟 → 𝐋𝐎𝐂𝐊 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄
𝐭𝐚𝐫𝐠𝐞𝐭 𝐨𝐧/off <userID> → 𝐓𝐀𝐑𝐆𝐄𝐓 𝐋𝐎𝐂𝐊
═══════════════════`);
    return api.sendMessage(help, threadID);
  }

  // === Conversation flow for non-command messages ===
  if (conversationState[threadID] === 0 && msg.includes('hello')) {
    const reply = await formatMessage(api, event, 'hello I am fine');
    await api.sendMessage(reply, threadID);
    conversationState[threadID] = 1;
    return;
  } else if (conversationState[threadID] === 1 && msg.includes('hi kaise ho')) {
    const reply = await formatMessage(api, event, 'thik hu tum kaise ho');
    await api.sendMessage(reply, threadID);
    conversationState[threadID] = 0;
    return;
  }

  // === MASTI AUTO REPLY ===
  const randomReply = mastiReplies[Math.floor(Math.random() * mastiReplies.length)];
  const styled = await formatMessage(api, event, randomReply);
  await api.sendMessage(styled, threadID);
}

// === GROUP COMMAND ===
async function handleGroupCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  if (sub === 'on') {
    const name = args.join(' ').trim();
    if (!name) return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}group on <name>`), threadID);
    lockedGroups[threadID] = name;
    try { await api.setTitle(name, threadID); } catch {}
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, `Group name locked to "${name}".`), threadID);
  } else if (sub === 'off') {
    delete lockedGroups[threadID];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Group name unlocked.'), threadID);
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}group on/off`), threadID);
  }
}

// === NICKNAME COMMAND ===
async function handleNicknameCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  if (sub === 'on') {
    const nick = args.join(' ').trim();
    if (!nick) return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}nickname on <nick>`), threadID);
    lockedNicknames[threadID] = nick;
    try {
      const info = await api.getThreadInfo(threadID);
      for (const pid of info.participantIDs || []) {
        if (pid !== adminID) {
          await api.changeNickname(nick, threadID, pid);
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } catch {}
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, `Nicknames locked to "${nick}".`), threadID);
  } else if (sub === 'off') {
    delete lockedNicknames[threadID];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Nickname lock disabled.'), threadID);
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}nickname on/off`), threadID);
  }
}

// === TARGET COMMAND ===
/*
 Usage:
  /target on <userID>   -> lock target to that user (only they will get bot replies)
  /target off           -> unlock target
  /target info          -> show current target
*/
async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  if (sub === 'on') {
    const candidate = args.join(' ').trim();
    if (!candidate) {
      return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}target on <userID>`), threadID);
    }
    let targetID = candidate;
    lockedTargets[threadID] = String(targetID);
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, `Target locked to "${targetID}". Bot will reply only to that user.`), threadID);
  } else if (sub === 'off') {
    delete lockedTargets[threadID];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Target unlocked. Bot will reply normally.'), threadID);
  } else if (sub === 'info') {
    const t = lockedTargets[threadID];
    return api.sendMessage(await formatMessage(api, event, `Current target: ${t || 'None'}`), threadID);
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}target on/off/info`), threadID);
  }
}

// === AUTO RESTORE ===
async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
      const info = await botAPI.getThreadInfo(thread.threadID);
      if (info?.nicknames?.[botID] !== botNickname) {
        await botAPI.changeNickname(botNickname, thread.threadID, botID);
        emitLog(`Bot nickname set in ${thread.threadID}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    emitLog('Nickname set error: ' + e.message, true);
  }
}

// === THREAD NAME LOCK ===
async function handleThreadNameChange(api, event) {
  const { threadID, authorID } = event;
  const newTitle = event.logMessageData?.name;
  if (lockedGroups[threadID] && authorID !== adminID && newTitle !== lockedGroups[threadID]) {
    await api.setTitle(lockedGroups[threadID], threadID);
    const user = await api.getUserInfo(authorID).catch(() => ({}));
    const name = user?.[authorID]?.name || 'User';
    await api.sendMessage({ body: `@${name} group name locked!`, mentions: [{ tag: name, id: authorID }] }, threadID);
  }
}

// === NICKNAME LOCK ===
async function handleNicknameChange(api, event) {
  const { threadID, authorID, participantID, newNickname } = event;
  const botID = api.getCurrentUserID();
  if (participantID === botID && authorID !== adminID && newNickname !== botNickname) {
    await api.changeNickname(botNickname, threadID, botID);
  }
  if (lockedNicknames[threadID] && authorID !== adminID && newNickname !== lockedNicknames[threadID]) {
    await api.changeNickname(lockedNicknames[threadID], threadID, participantID);
  }
}

// === BOT ADDED ===
async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessageData } = event;
  const botID = api.getCurrentUserID();
  if (logMessageData?.addedParticipants?.some(p => String(p.userFbId) === String(botID))) {
    await api.changeNickname(botNickname, threadID, botID);
    await api.sendMessage(`Hello! I'm online. Use ${prefix}group, ${prefix}nickname or ${prefix}target to manage locks.`, threadID);
  }
}

// === DASHBOARD ===
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/configure', (req, res) => {
  try {
    const cookies = typeof req.body.cookies === 'string' ? JSON.parse(req.body.cookies) : req.body.cookies;
    prefix = req.body.prefix || prefix;
    adminID = req.body.adminID || adminID;
    if (!Array.isArray(cookies) || cookies.length === 0) return res.status(400).send('Invalid cookies');
    if (!adminID) return res.status(400).send('adminID required');
    currentCookies = cookies;
    saveConfig();
    res.send('Configured. Starting bot...');
    initializeBot(currentCookies, prefix, adminID);
  } catch (e) {
    emitLog('Config error: ' + e.message, true);
    res.status(400).send('Invalid data');
  }
});

// === AUTO LOAD CONFIG ===
try {
  if (fs.existsSync('config.json')) {
    const loaded = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    if (loaded.botNickname) botNickname = loaded.botNickname;
    if (loaded.prefix) prefix = loaded.prefix;
    if (loaded.adminID) adminID = loaded.adminID;
    if (loaded.lockedGroups) lockedGroups = loaded.lockedGroups;
    if (loaded.lockedNicknames) lockedNicknames = loaded.lockedNicknames;
    if (loaded.lockedTargets) lockedTargets = loaded.lockedTargets;
    if (Array.isArray(loaded.cookies) && loaded.cookies.length) {
      currentCookies = loaded.cookies;
      emitLog('Found saved cookies; starting bot.');
      initializeBot(currentCookies, prefix, adminID);
    } else emitLog('No cookies found. Configure via dashboard.');
  } else emitLog('No config.json found. Configure via dashboard.');
} catch (e) {
  emitLog('Config load error: ' + e.message, true);
}

// === SERVER ===
const PORT = process.env.PORT || 20018;
server.listen(PORT, () => emitLog(`Server running on port ${PORT}`));
io.on('connection', socket => {
  emitLog('Dashboard connected');
  socket.emit('botlog', `Bot status: ${botAPI ? 'Started' : 'Not started'}`);
});
