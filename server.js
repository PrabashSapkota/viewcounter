const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// CORS Middleware to allow cross-origin requests (fixing "not working" issue)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});


/* ─── State Management ────────────────────────────────────────────────────── */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const roomsFilePath = path.join(DATA_DIR, 'rooms.json');
let rooms = {}; // roomId → roomState

function loadRooms() {
  try {
    if (fs.existsSync(roomsFilePath)) {
      const data = JSON.parse(fs.readFileSync(roomsFilePath, 'utf8'));
      rooms = data;
      for (const id in rooms) {
        rooms[id].users = {};
        rooms[id].bannedIds = new Set(rooms[id].bannedIds || []);
        rooms[id].lastMsgTime = {};
      }
    }
  } catch (e) {
    console.error('Error loading rooms.json:', e);
  }
}

function saveRooms() {
  try {
    const dataToSave = {};
    for (const id in rooms) {
      const room = rooms[id];
      dataToSave[id] = {
        messages:    room.messages,
        bannedIds:   Array.from(room.bannedIds),
        polls:       room.polls,
        pinnedMsgId: room.pinnedMsgId,
        slowMode:    room.slowMode,
        maxMessages: room.maxMessages,
      };
    }
    fs.writeFileSync(roomsFilePath, JSON.stringify(dataToSave, null, 2));
  } catch (e) {
    console.error('Error saving rooms.json:', e);
  }
}

function getRoom(id) {
  if (!id) id = 'default';
  if (!rooms[id]) {
    rooms[id] = {
      messages:    [],
      users:       {},
      bannedIds:   new Set(),
      polls:       [],
      pinnedMsgId: null,
      slowMode:    0,
      lastMsgTime: {},
      maxMessages: 400,
    };
  }
  return rooms[id];
}

loadRooms();

/* ── View Counter State ── */
const viewsFilePath = path.join(DATA_DIR, 'views.json');
let viewCounts = {};
let clientInfo = {}; // Track client info (IP, platform, etc.) if needed

function saveViews() {
  try {
    const filteredViews = {};
    for (const [id, count] of Object.entries(viewCounts)) {
      if (count > 0) filteredViews[id] = count;
    }
    fs.writeFileSync(viewsFilePath, JSON.stringify({ viewCounts: filteredViews, clientInfo: clientInfo }, null, 2));
  } catch (e) {
    console.error('Error saving views.json:', e);
  }
}

// Track viewers by socket ID (not userId) — one socket = one viewer
// roomId -> Set of socketIds
const roomViewerSockets = {};
// socketId -> { roomId }
const socketToRoom = {};

function updateRoomViewCount(roomId) {
  if (!roomId || roomId === 'default') return;
  const count = roomViewerSockets[roomId] ? roomViewerSockets[roomId].size : 0;
  viewCounts[roomId] = count;
  io.to(roomId).emit('updateViewCount', { id: roomId, viewCount: count });
}

setInterval(() => {
  saveViews();
  saveRooms();
}, 60000);


const ADMIN_PASS  = 'prabashsapkota';
const ADMIN_COLOR = '#ff6b35';
const MOD_COLOR   = '#7ed321';
const COLORS = ['#61dafb','#c084fc','#fb923c','#34d399','#f472b6','#a78bfa','#38bdf8','#fbbf24','#e879f9','#4ade80','#f87171','#60a5fa'];

const BAD_WORDS = ['fuck','shit','bitch','asshole','bastard','cunt','dick','pussy','cock','motherfucker','fag','faggot','nigger','nigga','retard','whore','slut','twat','wanker','bollocks','shite','arse','prick'];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function censor(text) {
  let r = text;
  for (const w of BAD_WORDS)
    r = r.replace(new RegExp(`\\b${w}\\b`, 'gi'), m => m[0] + '*'.repeat(m.length - 1));
  return r;
}
function randColor(seed) {
  if (!seed) return COLORS[Math.floor(Math.random() * COLORS.length)];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 65%)`;
}
function sysMsg(text) {
  return { id: uuidv4(), userId: 'system', username: 'System', text, type: 'system', ts: Date.now(), deleted: false, reactions: {} };
}
function push(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > room.maxMessages) room.messages.shift();
}
function broadcastUsers(roomId) {
  const room = getRoom(roomId);
  io.to(roomId).emit('users_update', Object.values(room.users).map(u => ({
    id: u.id, username: u.username, role: u.role, color: u.color, muted: u.muted
  })));
}
function broadcastSettings(roomId) {
  const room = getRoom(roomId);
  io.to(roomId).emit('chat_settings', {
    slowMode:    room.slowMode,
    pinnedMsgId: room.pinnedMsgId,
  });
}

/* ── GIF proxy (Giphy) ────────────────────────────────────────────────────── */
// Giphy: primary app keys + public beta fallback
const GIPHY_KEYS = [
  'YdA2bceXfqRYIxMwiEWFO9uwVyOGWe4w',
  '9vwOD0ckCPs1JvxBbi3fdVkSP7T6A9DG',
  'E9IBz1C24cwVQMy6XeR0m0X65B89OlPi',
  'x2NUFYUd98RwHScVZJbOLSBtereb5gZ5',
  'dc6zaTOxFJmzC'  // Giphy public beta key (always free, no rate limit for demos)
];
let currentKeyIndex = 0;

function mapGiphy(results = []) {
  return (results || [])
    .map(g => ({
      id:      g.id,
      preview: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || g.images?.preview_gif?.url || '',
      url:     g.images?.original?.url || g.images?.fixed_height?.url || '',
      title:   g.title || '',
    }))
    .filter(g => g.preview && g.url);
}

async function fetchGiphy(endpoint, params = '') {
  let attempts = 0;
  while (attempts < GIPHY_KEYS.length) {
    const key = GIPHY_KEYS[currentKeyIndex];
    try {
      const r = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?api_key=${key}${params}`);
      if (r.ok) {
        const d = await r.json();
        return d.data;
      }
      if (r.status === 401 || r.status === 429) {
        currentKeyIndex = (currentKeyIndex + 1) % GIPHY_KEYS.length;
      }
    } catch (e) {
      console.error(`Giphy attempt ${attempts} failed:`, e.message);
      currentKeyIndex = (currentKeyIndex + 1) % GIPHY_KEYS.length;
    }
    attempts++;
  }
  return [];
}

app.get('/api/gifs/trending', async (_req, res) => {
  const data = await fetchGiphy('trending', '&limit=24');
  res.json(mapGiphy(data));
});

app.get('/api/gifs/search', async (req, res) => {
  const q = encodeURIComponent(req.query.q || 'funny');
  const data = await fetchGiphy('search', `&q=${q}&limit=24`);
  res.json(mapGiphy(data));
});

app.get('/view-data', (req, res) => {
  res.json({ viewCounts, clientInfo });
});

/* ─── Socket.IO ───────────────────────────────────────────────────────────── */
io.on('connection', socket => {
  const roomId = socket.handshake.query.id;
  const userId = socket.handshake.query.userId;

  // ── Viewer count: track EVERY connection, regardless of chat join ──
  if (roomId && roomId !== 'default') {
    socket.join(roomId);

    if (!roomViewerSockets[roomId]) roomViewerSockets[roomId] = new Set();
    roomViewerSockets[roomId].add(socket.id);
    socketToRoom[socket.id] = roomId;

    updateRoomViewCount(roomId);

    socket.on('requestViewCount', () => {
      socket.emit('updateViewCount', {
        id: roomId,
        viewCount: roomViewerSockets[roomId]?.size || 0
      });
    });
  }

  /* JOIN CHAT (separate from viewer tracking) */
  socket.on('join', ({ username, userId: uid }) => {
    const room = getRoom(roomId);
    if (room.bannedIds.has(uid)) { socket.emit('banned'); socket.disconnect(); return; }

    const prev  = Object.values(room.users).find(u => u.id === uid);
    const color = prev?.color || randColor(uid);
    const role  = prev?.role  || 'user';

    room.users[socket.id] = { id: uid, username, role, color, muted: false, socketId: socket.id };

    socket.emit('joined', { userId: uid, role, color });
    socket.emit('chat_history',  room.messages.slice(-100));
    socket.emit('polls_update',  room.polls);
    socket.emit('chat_settings', { slowMode: room.slowMode, chatLocked: room.chatLocked, pinnedMsgId: room.pinnedMsgId });
    broadcastUsers(roomId);
  });

  /* SEND MESSAGE */
  socket.on('send_message', ({ text, type, replyToId }) => {
    const room = getRoom(roomId);
    const msgType = type || 'text';
    const user = room.users[socket.id];
    if (!user) return;

    if (room.bannedIds.has(user.id))                        { socket.emit('banned'); return; }
    if (user.muted)                                          { socket.emit('error_msg', '🔇 You are muted.'); return; }

    if (room.slowMode > 0 && user.role === 'user') {
      const last = room.lastMsgTime[user.id] || 0;
      if (Date.now() - last < room.slowMode * 1000)         { socket.emit('error_msg', `⏱ Slow mode: wait ${room.slowMode}s.`); return; }
    }

    /* Admin promote */
    if (text.trim() === `/admin=${ADMIN_PASS}`) {
      user.role = 'admin'; user.color = ADMIN_COLOR;
      socket.emit('role_update', { role: 'admin', color: ADMIN_COLOR });
      broadcastUsers(roomId);
      const m = sysMsg(`🛡️ ${user.username} is now Admin`);
      push(room, m); io.to(roomId).emit('new_message', m);
      return;
    }

    const body = msgType === 'text' ? censor(text) : text;
    const msg  = {
      id: uuidv4(),
      userId: user.id,
      username: user.username,
      text: body,
      type: msgType,
      ts: Date.now(),
      deleted: false,
      reactions: {},
      color: user.color,
      role: user.role,
      replyTo: replyToId ? room.messages.find(m => m.id === replyToId && !m.deleted) : null
    };
    room.lastMsgTime[user.id] = Date.now();
    push(room, msg); io.to(roomId).emit('new_message', msg);
  });

  /* TYPING */
  socket.on('typing', isTyping => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (user) socket.to(roomId).emit('user_typing', { username: user.username, isTyping });
  });

  /* REACT */
  socket.on('react', ({ messageId, emoji }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user) return;
    const msg = room.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.id);
    if (idx === -1) msg.reactions[emoji].push(user.id);
    else            msg.reactions[emoji].splice(idx, 1);
    io.to(roomId).emit('reaction_update', { messageId, reactions: msg.reactions });
  });

  /* DELETE MESSAGE */
  socket.on('delete_message', id => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const msg = room.messages.find(m => m.id === id);
    if (msg) { msg.deleted = true; io.to(roomId).emit('message_deleted', id); }
  });

  /* PIN / UNPIN MESSAGE */
  socket.on('pin_message', id => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    room.pinnedMsgId = id;
    broadcastSettings(roomId);
  });

  /* CLEAR CHAT */
  socket.on('clear_chat', () => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || user.role !== 'admin') return;
    room.messages.length = 0; room.pinnedMsgId = null;
    io.to(roomId).emit('chat_cleared');
    const m = sysMsg('🗑️ Chat cleared by admin'); push(room, m); io.to(roomId).emit('new_message', m);
  });

  /* BAN */
  socket.on('ban_user', targetId => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    room.bannedIds.add(targetId);
    const t = Object.values(room.users).find(u => u.id === targetId);
    if (t) io.to(t.socketId).emit('banned');
    broadcastUsers(roomId);
  });

  /* MUTE */
  socket.on('mute_user', ({ targetUserId, muted }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const t = Object.values(room.users).find(u => u.id === targetUserId);
    if (!t) return;
    t.muted = muted;
    io.to(t.socketId).emit('muted', muted);
    broadcastUsers(roomId);
  });

  /* SET ROLE */
  socket.on('set_role', ({ targetUserId, role }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const t = Object.values(room.users).find(u => u.id === targetUserId);
    if (!t) return;
    t.role = role; t.color = role === 'mod' ? MOD_COLOR : randColor();
    io.to(t.socketId).emit('role_update', { role: t.role, color: t.color });
    const m = sysMsg(`⭐ ${t.username} is now ${role}`); push(room, m); io.to(roomId).emit('new_message', m);
    broadcastUsers(roomId);
  });

  /* SLOW MODE */
  socket.on('set_slow_mode', secs => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    room.slowMode = Math.max(0, parseInt(secs) || 0); broadcastSettings(roomId);
    const m = sysMsg(room.slowMode > 0 ? `⏱ Slow mode: ${room.slowMode}s` : '⏱ Slow mode off'); push(room, m); io.to(roomId).emit('new_message', m);
  });

  socket.on('unban_user', targetUserId => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || user.role !== 'admin') return;
    room.bannedIds.delete(targetUserId);
  });

  socket.on('create_poll', ({ question, options }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const poll = { id: uuidv4(), question, options: options.map(t => ({ text: t, votes: [] })), createdBy: user.username, active: true, ts: Date.now() };
    room.polls.push(poll);
    io.to(roomId).emit('polls_update', room.polls);
    const m = sysMsg(`📊 New poll: "${question}"`); push(room, m); io.to(roomId).emit('new_message', m);
  });

  /* VOTE POLL */
  socket.on('vote_poll', ({ pollId, optionIndex }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user) return;
    const poll = room.polls.find(p => p.id === pollId);
    if (!poll || !poll.active) return;
    poll.options.forEach(o => { const i = o.votes.indexOf(user.id); if (i !== -1) o.votes.splice(i, 1); });
    if (poll.options[optionIndex]) poll.options[optionIndex].votes.push(user.id);
    io.to(roomId).emit('polls_update', room.polls);
  });

  /* CLOSE / DELETE POLL */
  socket.on('close_poll', id => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const p = room.polls.find(p => p.id === id);
    if (p) { p.active = false; io.to(roomId).emit('polls_update', room.polls); }
  });
  socket.on('delete_poll', id => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const i = room.polls.findIndex(p => p.id === id);
    if (i !== -1) { room.polls.splice(i, 1); io.to(roomId).emit('polls_update', room.polls); }
  });

  /* WHISPER */
  socket.on('whisper', ({ targetUserId, text }) => {
    const room = getRoom(roomId);
    const user = room.users[socket.id];
    if (!user) return;
    const t = Object.values(room.users).find(u => u.id === targetUserId);
    if (!t) return;
    const base = { id: uuidv4(), userId: user.id, username: user.username, type: 'whisper', ts: Date.now(), deleted: false, reactions: {}, color: user.color, role: user.role };
    socket.emit('new_message',       { ...base, text: `💌 [to ${t.username}] ${censor(text)}` });
    io.to(t.socketId).emit('new_message', { ...base, text: `💌 [from ${user.username}] ${censor(text)}` });
  });

  /* DISCONNECT */
  socket.on('disconnect', () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      // Remove from viewer tracking
      if (roomViewerSockets[roomId]) {
        roomViewerSockets[roomId].delete(socket.id);
        updateRoomViewCount(roomId);
      }
      delete socketToRoom[socket.id];

      // Remove from chat users if they had joined chat
      const room = getRoom(roomId);
      if (room.users[socket.id]) {
        delete room.users[socket.id];
        broadcastUsers(roomId);
      }
    }
  });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  LiveChat  →  http://localhost:${PORT}`));
