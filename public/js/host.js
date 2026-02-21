/* ═══════════════════════════════════════
   Host / TV client
   ═══════════════════════════════════════ */
(() => {
  const socket = io();
  const audio  = new AudioManager();

  let roomCode      = '';
  let players       = [];
  let currentRound  = 0;
  let totalRounds   = 0;
  let roundResults  = null;
  let revealIdx     = 0;
  let revealTimer   = null;
  let revealDone    = false;

  /* ── DOM refs ── */
  const $ = (id) => document.getElementById(id);

  /* ── screen management ── */
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  /* ── init: ensure audio context on first click ── */
  document.addEventListener('click', () => audio.init(), { once: true });

  /* ══════════════════
     Create room on load
     ══════════════════ */
  socket.emit('create-room', getSettingsFromUI());

  /* ── settings UI ── */
  function getSettingsFromUI() {
    return {
      rounds:         parseInt($('set-rounds').value) || 6,
      answerTime:     parseInt($('set-time').value) || 20,
      hilo:           $('set-hilo').checked,
      familyFriendly: $('set-filter').checked,
    };
  }

  ['set-rounds','set-time','set-hilo','set-filter'].forEach(id => {
    $(id).addEventListener('change', () => socket.emit('update-settings', getSettingsFromUI()));
  });

  /* ══════════════════
     Socket events
     ══════════════════ */

  socket.on('room-created', (data) => {
    roomCode = data.code;
    $('room-code').textContent = roomCode;
    $('join-url').textContent = `Go to ${location.origin}`;
    show('screen-lobby');
  });

  socket.on('player-joined', (data) => {
    audio.playerJoin();
    addPlayerChip(data.player);
    updatePlayerCount(data.playerCount);
  });

  socket.on('player-left', (data) => {
    const chip = document.querySelector(`.player-chip[data-id="${data.playerId}"]`);
    if (chip) chip.remove();
    updatePlayerCount(data.playerCount);
  });

  socket.on('player-kicked', (data) => {
    const chip = document.querySelector(`.player-chip[data-id="${data.playerId}"]`);
    if (chip) chip.remove();
    updatePlayerCount(data.playerCount);
  });

  socket.on('game-starting', (data) => {
    totalRounds = data.totalRounds;
    players = data.players;
    audio.roundIntro();
    $('round-intro-text').textContent = 'GET READY!';
    show('screen-round-intro');
  });

  socket.on('round-start', (data) => {
    currentRound = data.round;

    // brief round intro
    $('round-intro-text').textContent = `ROUND ${data.round}`;
    show('screen-round-intro');
    audio.roundIntro();

    setTimeout(() => {
      $('round-label').textContent = `Round ${data.round} of ${data.totalRounds}`;
      $('category-text').textContent = data.category;
      $('host-timer').textContent = data.answerTime;
      $('host-timer').classList.remove('urgent');
      $('submission-counter').textContent = `0 / ${players.length} submitted`;
      show('screen-category');
    }, 2500);
  });

  socket.on('timer-tick', (data) => {
    const sec = data.seconds;
    // update whichever timer is visible
    const activeScreen = document.querySelector('.screen.active');
    if (!activeScreen) return;

    if (activeScreen.id === 'screen-category') {
      $('host-timer').textContent = sec;
      $('host-timer').classList.toggle('urgent', sec <= 5);
      if (sec <= 5 && sec > 0) audio.countdown();
      if (sec === 0) audio.countdownFinal();
    } else if (activeScreen.id === 'screen-hilo-wait') {
      $('hilo-timer').textContent = sec;
      $('hilo-timer').classList.toggle('urgent', sec <= 3);
    }
  });

  socket.on('submission-update', (data) => {
    $('submission-counter').textContent = `${data.submitted} / ${data.total} submitted`;
  });

  socket.on('answers-locked', () => {
    // if hilo is disabled we'll get results directly; if enabled we show hilo wait
  });

  socket.on('hilo-phase', (data) => {
    $('hilo-round-label').textContent = `Round ${currentRound} of ${totalRounds}`;
    $('hilo-timer').textContent = data.time;
    $('hilo-timer').classList.remove('urgent');
    show('screen-hilo-wait');
  });

  socket.on('round-results', (data) => {
    roundResults = data;
    startReveal(data);
  });

  socket.on('game-over', (data) => {
    showGameOver(data.scores);
    audio.fanfare();
  });

  socket.on('back-to-lobby', (data) => {
    players = data.players;
    rebuildPlayerList(data.players);
    show('screen-lobby');
  });

  socket.on('settings-updated', (data) => {
    totalRounds = data.totalRounds;
  });

  socket.on('error-msg', (msg) => {
    console.error('Server:', msg);
  });

  /* ══════════════════
     Host controls
     ══════════════════ */

  $('btn-start').addEventListener('click', () => socket.emit('start-game'));

  $('btn-next-round').addEventListener('click', () => socket.emit('next-round'));

  $('btn-play-again').addEventListener('click', () => socket.emit('play-again'));

  $('btn-skip-reveal').addEventListener('click', () => skipReveal());

  /* ══════════════════
     Lobby helpers
     ══════════════════ */

  function addPlayerChip(p) {
    const list = $('player-list');
    // avoid dupes
    if (document.querySelector(`.player-chip[data-id="${p.id}"]`)) return;

    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.dataset.id = p.id;
    chip.innerHTML = `
      <div class="dot" style="background:${p.color}">${p.name.charAt(0).toUpperCase()}</div>
      <span class="name">${esc(p.name)}</span>
      <button class="kick-btn" title="Kick">✕</button>
    `;
    chip.querySelector('.kick-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('kick-player', p.id);
    });
    list.appendChild(chip);

    // track locally
    if (!players.find(x => x.id === p.id)) players.push(p);
  }

  function updatePlayerCount(n) {
    $('player-count').textContent = n === 0
      ? 'Waiting for players…'
      : `${n} player${n > 1 ? 's' : ''} connected`;
    $('btn-start').disabled = n < 2;
  }

  function rebuildPlayerList(list) {
    $('player-list').innerHTML = '';
    list.forEach(p => addPlayerChip(p));
    updatePlayerCount(list.length);
  }

  /* ══════════════════
     Reveal animation
     ══════════════════ */

  function startReveal(data) {
    revealIdx  = 0;
    revealDone = false;

    $('reveal-round-label').textContent = `Round ${data.round} of ${data.totalRounds}`;
    $('reveal-category').textContent = data.category;

    const board = $('reveal-board');
    board.innerHTML = '';

    // build rows from rank 1 → 10 (display order top → bottom)
    const sorted = [...data.rankedAnswers].sort((a, b) => a.rank - b.rank);
    sorted.forEach(a => {
      const row = document.createElement('div');
      row.className = 'reveal-row';
      row.dataset.rank = a.rank;

      const rankCls = a.rank <= 3 ? ` r${a.rank}` : '';
      row.innerHTML = `
        <div class="reveal-rank${rankCls}">#${a.rank}</div>
        <div class="reveal-answer">???</div>
        <div class="reveal-points">${a.points} pts</div>
        <div class="reveal-players"></div>
      `;
      board.appendChild(row);
    });

    show('screen-reveal');

    // reveal from rank 10 → 1 (bottom-up dramatic reveal)
    const revealOrder = [...sorted].reverse(); // 10, 9, 8, …, 1
    revealIdx = 0;

    revealTimer = setInterval(() => {
      if (revealIdx >= revealOrder.length) {
        clearInterval(revealTimer);
        revealDone = true;
        // auto-advance to scores after 3s
        setTimeout(() => {
          if (revealDone) showRoundScores(data);
        }, 3000);
        return;
      }
      revealOne(revealOrder[revealIdx], board);
      revealIdx++;
    }, 1800);
  }

  function revealOne(answerData, board) {
    const row = board.querySelector(`.reveal-row[data-rank="${answerData.rank}"]`);
    if (!row) return;

    row.classList.add('revealed');
    row.querySelector('.reveal-answer').textContent = answerData.text.toUpperCase();

    if (answerData.matchedPlayers.length > 0) {
      row.classList.add('matched');
      const cont = row.querySelector('.reveal-players');
      answerData.matchedPlayers.forEach(p => {
        const tag = document.createElement('span');
        tag.className = 'reveal-player-tag';
        tag.style.background = p.color;
        tag.textContent = p.name;
        cont.appendChild(tag);
      });
      audio.matchFound();
    } else {
      audio.reveal();
    }
  }

  function skipReveal() {
    if (revealTimer) clearInterval(revealTimer);
    if (!roundResults) return;

    const board = $('reveal-board');
    const sorted = [...roundResults.rankedAnswers].sort((a, b) => a.rank - b.rank);
    sorted.forEach(a => revealOne(a, board));

    revealDone = true;
    setTimeout(() => showRoundScores(roundResults), 1200);
  }

  /* ══════════════════
     Scoreboard
     ══════════════════ */

  function showRoundScores(data) {
    if (revealTimer) clearInterval(revealTimer);

    $('scores-title').textContent = data.isLastRound ? 'FINAL SCORES' : `SCORES – ROUND ${data.round}`;
    $('btn-next-round').textContent = data.isLastRound ? 'SHOW WINNER 🏆' : 'NEXT ROUND ▸';

    const sb = $('round-scoreboard');
    sb.innerHTML = '';

    data.scores.forEach((s, i) => {
      // find delta from playerResults
      const pr = data.playerResults.find(r => r.playerId === s.id);
      const delta = pr ? pr.roundScore : 0;

      const entry = document.createElement('div');
      entry.className = 'score-entry';
      entry.innerHTML = `
        <div class="score-pos" style="color:${s.color}">${i + 1}</div>
        <div class="score-name">${esc(s.name)}</div>
        <div class="score-pts">${s.score.toLocaleString()}<span class="score-delta">+${delta}</span></div>
      `;
      sb.appendChild(entry);
    });

    show('screen-round-scores');
  }

  /* ══════════════════
     Game Over
     ══════════════════ */

  function showGameOver(scores) {
    // podium
    const podium = $('podium');
    podium.innerHTML = '';

    const order = [1, 0, 2]; // display: silver, gold, bronze
    const classes = ['second', 'first', 'third'];
    const emojis  = ['🥈', '🥇', '🥉'];

    order.forEach((idx, displayIdx) => {
      const s = scores[idx];
      if (!s) return;
      const slot = document.createElement('div');
      slot.className = 'podium-slot';
      slot.innerHTML = `
        <div class="podium-name">${esc(s.name)}</div>
        <div class="podium-score">${s.score.toLocaleString()}</div>
        <div class="podium-bar ${classes[displayIdx]}">
          <span class="podium-place">${emojis[displayIdx]}</span>
        </div>
      `;
      podium.appendChild(slot);
    });

    // full scoreboard
    const sb = $('final-scoreboard');
    sb.innerHTML = '';
    scores.forEach((s, i) => {
      const entry = document.createElement('div');
      entry.className = 'score-entry';
      entry.innerHTML = `
        <div class="score-pos" style="color:${s.color}">${i + 1}</div>
        <div class="score-name">${esc(s.name)}</div>
        <div class="score-pts">${s.score.toLocaleString()}</div>
      `;
      sb.appendChild(entry);
    });

    show('screen-game-over');
  }

  /* ── util ── */
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
