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
  let gameMode      = 'topmatch';

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
    const checkedGroups = [...document.querySelectorAll('#category-groups input:checked')]
      .map(cb => cb.value);
    return {
      rounds:         parseInt($('set-rounds').value) || 6,
      answerTime:     parseInt($('set-time').value) || 20,
      hilo:           $('set-hilo').checked,
      familyFriendly: $('set-filter').checked,
      categoryGroups: checkedGroups.length ? checkedGroups : ['all'],
      gameMode:       $('set-gamemode').value || 'topmatch',
    };
  }

  ['set-rounds','set-time','set-hilo','set-filter','set-gamemode'].forEach(id => {
    $(id).addEventListener('change', () => socket.emit('update-settings', getSettingsFromUI()));
  });

  /* ── game mode toggle ── */
  $('set-gamemode').addEventListener('change', () => {
    const mode = $('set-gamemode').value;
    $('hilo-setting-row').style.display = mode === 'nutshell' ? 'none' : '';
    $('category-groups-section').style.display = mode === 'nutshell' ? 'none' : '';
    $('team-display').style.display = mode === 'nutshell' ? '' : 'none';
  });

  /* ── load category groups into lobby ── */
  (async () => {
    try {
      const res  = await fetch('/category-groups');
      const data = await res.json();
      const wrap = $('category-groups');
      if (!wrap) return;

      data.forEach(g => {
        const lbl = document.createElement('label');
        lbl.className = 'cat-group-label';
        lbl.innerHTML =
          `<input type="checkbox" value="${g.id}" checked />` +
          `<span>${g.label} (${g.count})</span>`;
        wrap.appendChild(lbl);
      });

      // re-emit settings after groups are rendered
      wrap.addEventListener('change', () => socket.emit('update-settings', getSettingsFromUI()));
    } catch (e) { console.warn('Could not load category groups', e); }
  })();

  /* ══════════════════
     Socket events
     ══════════════════ */

  socket.on('room-created', async (data) => {
    roomCode = data.code;
    $('room-code').textContent = roomCode;

    // Build join URL — prefer LAN IP so other devices can reach it
    let joinBase = location.origin;
    try {
      const res = await fetch('/network-info');
      const info = await res.json();
      if (info.ips && info.ips.length) {
        // Pick the Wi-Fi IP (usually not 192.168.137.x hotspot)
        const wifiIP = info.ips.find(ip => !ip.startsWith('192.168.137')) || info.ips[0];
        joinBase = `http://${wifiIP}:${info.port}`;
      }
    } catch (_) { /* fallback to location.origin */ }

    const joinURL = `${joinBase}?code=${roomCode}`;
    $('join-url').textContent = `Go to ${joinBase}`;

    // Generate QR code via server endpoint (includes room code)
    $('qr-img').src = `/qr?url=${encodeURIComponent(joinURL)}`;

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
    gameMode = data.gameMode || 'topmatch';
    if (data.teams) currentTeams = data.teams;
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
    } else if (activeScreen.id === 'screen-nutshell-board') {
      $('nutshell-turn-timer').textContent = sec;
      $('nutshell-turn-timer').classList.toggle('urgent', sec <= 5);
      if (sec <= 5 && sec > 0) audio.countdown();
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
    if (data.teams) {
      currentTeams = data.teams;
      renderTeamDisplay(data.teams);
    }
    show('screen-lobby');
  });

  socket.on('settings-updated', (data) => {
    totalRounds = data.totalRounds;
    // sync gameMode for team display visibility
    if (data.gameMode) {
      gameMode = data.gameMode;
      $('team-display').style.display = data.gameMode === 'nutshell' ? '' : 'none';
    }
  });

  /* ── team updates ── */

  socket.on('teams-updated', (data) => {
    currentTeams = data;
    renderTeamDisplay(data);
  });

  /* ── nutshell board game events ── */

  let nutshellBoardData = { totalWords: 0, revealedIndices: [], revealedWords: {} };
  let currentTeams = { team1: [], team2: [], unassigned: [] };

  socket.on('nutshell-round-start', (data) => {
    currentRound = data.round;
    if (data.teams) currentTeams = data.teams;
    nutshellBoardData = { totalWords: data.totalWords, revealedIndices: [], revealedWords: {} };

    $('round-intro-text').textContent = `ROUND ${data.round}`;
    show('screen-round-intro');
    audio.roundIntro();

    setTimeout(() => {
      $('nutshell-round-label').textContent = `Round ${data.round} of ${data.totalRounds}`;
      $('nutshell-category').textContent = `🥜 ${data.category}`;
      $('nutshell-points-value').textContent = '1000';
      $('nutshell-turn-timer').textContent = '30';
      $('nutshell-turn-timer').classList.remove('urgent');
      $('nutshell-activity-log').innerHTML = '';
      renderNutshellBoard();
      updateTeamScores();
      show('screen-nutshell-board');
    }, 2500);
  });

  socket.on('nutshell-turn', (data) => {
    nutshellBoardData.revealedIndices = data.revealedIndices;
    nutshellBoardData.revealedWords = data.revealedWords;
    nutshellBoardData.totalWords = data.totalWords;

    const teamEmoji = data.teamTurn === 1 ? '🔴' : '🔵';
    const teamName = data.teamTurn === 1 ? 'Team Red' : 'Team Blue';
    $('nutshell-turn-team').textContent = `${teamEmoji} ${teamName}`;
    $('nutshell-turn-banner').className = `nutshell-turn-banner team-${data.teamTurn === 1 ? 'red' : 'blue'}-bg`;
    $('nutshell-points-value').textContent = data.pointsAvailable;
    $('nutshell-turn-timer').textContent = '30';
    $('nutshell-turn-timer').classList.remove('urgent');
    renderNutshellBoard();
  });

  socket.on('nutshell-word-revealed', (data) => {
    nutshellBoardData.revealedIndices = data.revealedIndices;
    nutshellBoardData.revealedWords = data.revealedWords;
    $('nutshell-points-value').textContent = data.pointsAvailable;
    renderNutshellBoard(data.wordIndex);

    const teamLabel = data.revealedByTeam === 1 ? '🔴' : '🔵';
    addActivityLog(`${teamLabel} ${esc(data.revealedByName)} pulled card #${data.wordIndex + 1}: "${esc(data.word)}"`);
    audio.reveal();
  });

  socket.on('nutshell-wrong-guess', (data) => {
    const teamLabel = data.team === 1 ? '🔴' : '🔵';
    addActivityLog(`${teamLabel} ${esc(data.playerName)} guessed wrong! Turn passes.`, 'wrong');
    audio.noMatch();
  });

  socket.on('nutshell-correct-guess', (data) => {
    const teamLabel = data.team === 1 ? '🔴' : '🔵';
    addActivityLog(`${teamLabel} ${esc(data.playerName)} guessed correctly! +${data.points} pts`, 'correct');
    audio.matchFound();
  });

  socket.on('nutshell-turn-timeout', (data) => {
    const teamLabel = data.team === 1 ? '🔴' : '🔵';
    addActivityLog(`${teamLabel} Time's up! Turn passes.`, 'timeout');
  });

  socket.on('nutshell-round-results', (data) => {
    $('nutshell-results-label').textContent = `Round ${data.round} of ${data.totalRounds}`;
    $('nutshell-answer-reveal').innerHTML = `<span class="answer-label">Answer:</span> <span class="answer-text">${esc(data.answer)}</span>`;
    $('nutshell-results-question').textContent = `"${data.question}"`;

    // Winner banner
    const wb = $('nutshell-winner-banner');
    if (data.winningTeam) {
      const teamEmoji = data.winningTeam === 1 ? '🔴' : '🔵';
      const teamName = data.winningTeam === 1 ? 'Team Red' : 'Team Blue';
      wb.innerHTML = `${teamEmoji} ${teamName} wins! <span class="winner-pts">+${data.points} pts</span><br/><small>Guessed by ${esc(data.guessedBy)} with ${data.revealedCount}/${data.totalWords} cards pulled</small>`;
      wb.className = `nutshell-winner-banner team-${data.winningTeam === 1 ? 'red' : 'blue'}-bg`;
    } else {
      wb.innerHTML = 'No team guessed correctly!';
      wb.className = 'nutshell-winner-banner';
    }

    // Team scoreboard
    const tsb = $('nutshell-team-scoreboard');
    tsb.innerHTML = `
      <div class="ts-result-row"><span class="ts-label">🔴 Team Red</span><span class="ts-score">${(data.teamScores?.team1 || 0).toLocaleString()}</span></div>
      <div class="ts-result-row"><span class="ts-label">🔵 Team Blue</span><span class="ts-score">${(data.teamScores?.team2 || 0).toLocaleString()}</span></div>
    `;

    $('btn-nutshell-next').textContent = data.isLastRound ? 'SHOW WINNER 🏆' : 'NEXT ROUND ▸';

    show('screen-nutshell-results');
    audio.reveal();
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

  $('btn-nutshell-next').addEventListener('click', () => socket.emit('next-round'));

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

    // reveal all answers at once
    const revealOrder = [...sorted].reverse(); // 10, 9, 8, …, 1
    revealOrder.forEach(a => revealOne(a, board));
    revealDone = true;

    // auto-advance to scores after 4s
    setTimeout(() => {
      if (revealDone) showRoundScores(data);
    }, 4000);
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

  /* ══════════════════
     Nutshell Card Board Rendering
     ══════════════════ */

  function renderNutshellBoard(justRevealedIdx) {
    const board = $('nutshell-board');
    const total = nutshellBoardData.totalWords;
    if (total === 0) return;

    // On first render, build the cards
    if (board.children.length !== total) {
      board.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.dataset.idx = i;
        card.innerHTML = `
          <div class="card-inner">
            <div class="card-back">
              <div class="card-pattern"></div>
              <span class="card-num">${i + 1}</span>
            </div>
            <div class="card-front">
              <span class="card-word"></span>
            </div>
          </div>
        `;
        board.appendChild(card);
      }
    }

    // Update state of each card
    for (let i = 0; i < total; i++) {
      const card = board.children[i];
      if (!card) continue;
      const isRevealed = nutshellBoardData.revealedIndices.includes(i);
      const wordEl = card.querySelector('.card-word');

      if (isRevealed && !card.classList.contains('flipped')) {
        wordEl.textContent = nutshellBoardData.revealedWords[i] || '';
        if (i === justRevealedIdx) {
          // Dramatic pull + flip
          card.classList.add('pulling');
          setTimeout(() => {
            card.classList.remove('pulling');
            card.classList.add('flipped');
            // Sparkle burst
            spawnSparkles(card);
          }, 300);
        } else {
          card.classList.add('flipped');
        }
      } else if (isRevealed) {
        wordEl.textContent = nutshellBoardData.revealedWords[i] || '';
      }
    }
  }

  function spawnSparkles(card) {
    for (let i = 0; i < 8; i++) {
      const spark = document.createElement('div');
      spark.className = 'card-sparkle';
      spark.style.setProperty('--angle', `${i * 45}deg`);
      spark.style.setProperty('--delay', `${Math.random() * 0.15}s`);
      card.appendChild(spark);
      setTimeout(() => spark.remove(), 700);
    }
  }

  function updateTeamScores() {
    // Calculate from players array
    let t1 = 0, t2 = 0;
    for (const p of players) {
      if (p.team === 1) t1 += p.score || 0;
      if (p.team === 2) t2 += p.score || 0;
    }
    const el1 = $('ns-team1-score');
    const el2 = $('ns-team2-score');
    if (el1) el1.textContent = t1.toLocaleString();
    if (el2) el2.textContent = t2.toLocaleString();
  }

  function addActivityLog(msg, type) {
    const log = $('nutshell-activity-log');
    if (!log) return;
    const entry = document.createElement('div');
    entry.className = `activity-entry${type ? ' activity-' + type : ''}`;
    entry.innerHTML = msg;
    log.prepend(entry);
    // Keep max 8 entries
    while (log.children.length > 8) log.lastChild.remove();
  }

  /* ══════════════════
     Team Display (Lobby)
     ══════════════════ */

  function renderTeamDisplay(teams) {
    const t1 = $('team-1-list');
    const t2 = $('team-2-list');
    if (!t1 || !t2) return;

    t1.innerHTML = '';
    t2.innerHTML = '';

    (teams.team1 || []).forEach(p => {
      const tag = document.createElement('div');
      tag.className = 'team-member';
      tag.innerHTML = `<span class="dot" style="background:${p.color}">${p.name.charAt(0).toUpperCase()}</span> ${esc(p.name)}`;
      t1.appendChild(tag);
    });

    (teams.team2 || []).forEach(p => {
      const tag = document.createElement('div');
      tag.className = 'team-member';
      tag.innerHTML = `<span class="dot" style="background:${p.color}">${p.name.charAt(0).toUpperCase()}</span> ${esc(p.name)}`;
      t2.appendChild(tag);
    });

    const ua = $('team-unassigned');
    const uaNames = $('team-unassigned-names');
    if (teams.unassigned && teams.unassigned.length > 0) {
      ua.style.display = '';
      uaNames.textContent = teams.unassigned.map(p => p.name).join(', ');
    } else {
      ua.style.display = 'none';
    }
  }
})();
