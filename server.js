const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const Room     = require('./game/Room');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

/* ─── room store ─── */
const rooms = new Map();

// Purge stale rooms every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.isEmpty() && now - room.createdAt > 30 * 60_000) {
      room.cleanup();
      rooms.delete(code);
    }
  }
}, 5 * 60_000);

/* ─── socket handling ─── */
io.on('connection', (socket) => {
  console.log(`+ connected  ${socket.id}`);

  /* ── HOST events ── */

  socket.on('create-room', (settings = {}) => {
    try {
      const room = new Room(socket.id, settings, io);
      while (rooms.has(room.code)) room.code = Room.generateCode();
      rooms.set(room.code, room);
      socket.join(room.code);
      socket.data = { role: 'host', roomCode: room.code };
      socket.emit('room-created', { code: room.code, settings: room.getSettings() });
      console.log(`  room ${room.code} created by ${socket.id}`);
    } catch (e) { socket.emit('error-msg', e.message); }
  });

  socket.on('start-game', () => {
    const room = hostRoom(socket); if (!room) return;
    try { room.startGame(); } catch (e) { socket.emit('error-msg', e.message); }
  });

  socket.on('kick-player', (pid) => {
    const room = hostRoom(socket); if (!room) return;
    room.kickPlayer(pid);
  });

  socket.on('next-round', () => {
    const room = hostRoom(socket); if (!room) return;
    room.advanceToNextRound();
  });

  socket.on('play-again', () => {
    const room = hostRoom(socket); if (!room) return;
    room.playAgain();
  });

  socket.on('update-settings', (s) => {
    const room = hostRoom(socket); if (!room) return;
    room.updateSettings(s);
  });

  /* ── PLAYER events ── */

  socket.on('join-room', ({ code, name } = {}) => {
    try {
      code = (code || '').toUpperCase().trim();
      name = (name || '').trim();
      if (!code || !name) return socket.emit('join-error', 'Room code and name are required.');
      if (name.length > 16) return socket.emit('join-error', 'Name must be 16 characters or fewer.');

      const room = rooms.get(code);
      if (!room) return socket.emit('join-error', 'Room not found – check the code.');

      const result = room.addPlayer(socket.id, name);
      if (result.error) return socket.emit('join-error', result.error);

      socket.join(code);
      socket.data = { role: 'player', roomCode: code, playerId: result.player.id };
      socket.emit('join-success', { player: result.player, roomState: room.getPlayerState() });
      io.to(code).emit('player-joined', { player: result.player, playerCount: room.getPlayerCount() });
      console.log(`  ${name} joined ${code}`);
    } catch (e) { socket.emit('join-error', e.message); }
  });

  socket.on('submit-answer', (answer) => {
    const room = playerRoom(socket); if (!room) return;
    room.submitAnswer(socket.data.playerId, answer);
  });

  socket.on('submit-hilo', (prediction) => {
    const room = playerRoom(socket); if (!room) return;
    room.submitHiLo(socket.data.playerId, prediction);
  });

  /* ── disconnect ── */

  socket.on('disconnect', () => {
    const d = socket.data || {};
    if (d.role === 'host') {
      const room = rooms.get(d.roomCode);
      if (room) {
        room.hostDisconnected();
        setTimeout(() => { if (!room.hostId) { room.cleanup(); rooms.delete(d.roomCode); } }, 30_000);
      }
    } else if (d.role === 'player') {
      const room = rooms.get(d.roomCode);
      if (room) room.removePlayer(d.playerId);
    }
    console.log(`- disconnected ${socket.id}`);
  });

  /* ── helpers ── */

  function hostRoom(s) {
    if (s.data?.role !== 'host') { s.emit('error-msg', 'Not a host'); return null; }
    const r = rooms.get(s.data.roomCode);
    if (!r) { s.emit('error-msg', 'Room gone'); return null; }
    return r;
  }
  function playerRoom(s) {
    if (s.data?.role !== 'player') { s.emit('error-msg', 'Not a player'); return null; }
    const r = rooms.get(s.data.roomCode);
    if (!r) { s.emit('error-msg', 'Room gone'); return null; }
    return r;
  }
});

/* ─── start ─── */
server.listen(PORT, () => {
  console.log(`\n🎮  Top Match — Jackbox-style party game`);
  console.log(`   Host a game  →  http://localhost:${PORT}/host.html`);
  console.log(`   Join a game  →  http://localhost:${PORT}\n`);
});
