/* ═══════════════════════════════════════
   Player / Phone client
   ═══════════════════════════════════════ */
(() => {
  const socket = io();
  const audio  = new AudioManager();

  const params   = new URLSearchParams(window.location.search);
  const roomCode = (params.get('code') || '').toUpperCase().trim();
  const nickname = (params.get('name') || '').trim();

  let myPlayer = null;
  let gameMode  = 'topmatch';
  let myTeam    = null;
  let nutshellState = { revealedIndices: [], revealedWords: {}, totalWords: 0, teamTurn: 0 };

  /* ── DOM helpers ── */
  const $ = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.player-body').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  /* ── init audio on first tap ── */
  document.addEventListener('touchstart', () => audio.init(), { once: true });
  document.addEventListener('click',      () => audio.init(), { once: true });

  /* ══════════════════
     Join on load
     ══════════════════ */

  if (!roomCode || !nickname) {
    window.location.href = '/';
  } else {
    socket.emit('join-room', { code: roomCode, name: nickname });
  }

  /* ══════════════════
     Socket events
     ══════════════════ */

  socket.on('join-success', (data) => {
    myPlayer = data.player;
    myTeam = data.player.team || null;
    $('player-header').classList.remove('hidden');
    $('header-name').textContent = myPlayer.name;
    $('header-code').textContent = roomCode;
    showScreen('screen-waiting');

    // Show team selection if nutshell mode
    const mode = data.roomState?.settings?.gameMode;
    if (mode) gameMode = mode;
    toggleTeamSelect();

    audio.ding();
  });

  socket.on('join-error', (msg) => {
    alert(msg);
    window.location.href = '/';
  });

  socket.on('game-starting', (data) => {
    gameMode = data.gameMode || 'topmatch';
    if (data.teams) {
      // Update player scores from teams data
    }
    showScreen('screen-game-starting');
  });

  socket.on('round-start', (data) => {
    $('p-round').textContent = `Round ${data.round} of ${data.totalRounds}`;
    $('p-category').textContent = data.category;
    $('p-timer').textContent = data.answerTime;
    $('p-timer').classList.remove('urgent');
    $('answer-input').value = '';
    $('answer-input').disabled = false;
    $('submit-btn').disabled = false;
    $('answer-error').style.display = 'none';

    showScreen('screen-answer');

    // focus input after a brief delay (for mobile keyboards)
    setTimeout(() => $('answer-input').focus(), 400);
  });

  socket.on('timer-tick', (data) => {
    const sec = data.seconds;

    // update answer timer
    const timerEl = $('p-timer');
    if (timerEl && !$('screen-answer').classList.contains('hidden')) {
      timerEl.textContent = sec;
      timerEl.classList.toggle('urgent', sec <= 5);
      if (sec <= 5 && sec > 0) audio.countdown();
      if (sec === 0) audio.countdownFinal();
    }

    // update hilo timer
    const hiloT = $('hilo-timer');
    if (hiloT && !$('screen-hilo').classList.contains('hidden')) {
      hiloT.textContent = sec;
      hiloT.classList.toggle('urgent', sec <= 3);
    }

    // update nutshell turn timer
    const nutT = $('p-nutshell-timer');
    if (nutT && !$('screen-nutshell-turn').classList.contains('hidden')) {
      nutT.textContent = sec;
      nutT.classList.toggle('urgent', sec <= 5);
      if (sec <= 5 && sec > 0) audio.countdown();
    }
  });

  socket.on('answer-received', (data) => {
    $('submitted-answer').textContent = `"${data.answer}"`;
    showScreen('screen-submitted');
    audio.submit();
  });

  socket.on('answer-rejected', (msg) => {
    $('answer-error').textContent = msg;
    $('answer-error').style.display = 'block';
    $('submit-btn').disabled = false;
    $('answer-input').disabled = false;
    $('answer-input').value = '';
    $('answer-input').focus();

    // shake the input to draw attention
    const input = $('answer-input');
    input.classList.add('shake-anim');
    setTimeout(() => input.classList.remove('shake-anim'), 500);

    audio.noMatch();
  });

  socket.on('answers-locked', () => {
    // if we haven't submitted, show submitted screen anyway
    if (!$('screen-submitted').classList.contains('hidden')) return; // already showing
    // force lock
    $('submit-btn').disabled = true;
    $('answer-input').disabled = true;
  });

  socket.on('hilo-phase', (data) => {
    // only show if player submitted an answer
    $('hilo-timer').textContent = data.time;
    $('hilo-timer').classList.remove('urgent');
    showScreen('screen-hilo');
  });

  socket.on('hilo-received', (data) => {
    $('hilo-choice-text').textContent = `You chose ${data.prediction.toUpperCase()}!`;
    showScreen('screen-hilo-done');
    audio.submit();
  });

  socket.on('round-results', (data) => {
    const me = data.playerResults.find(r => r.playerId === myPlayer?.id);
    if (!me) {
      showScreen('screen-waiting');
      return;
    }

    $('res-answer').textContent = me.answer ? `"${me.answer}"` : '(no answer)';

    if (me.matchedRank) {
      $('res-rank').textContent = `Matched #${me.matchedRank} — "${me.matchedAnswer}"`;
      $('res-rank').className = 'result-rank text-success';
      audio.matchFound();
    } else {
      $('res-rank').textContent = me.answer ? 'Not on the list!' : 'No answer submitted';
      $('res-rank').className = 'result-rank text-danger';
      if (me.answer) audio.noMatch();
    }

    $('res-points').textContent = `+${me.roundScore}`;

    if (me.hiloChoice) {
      const icon = me.hiloCorrect ? '✅' : '❌';
      $('res-hilo').textContent = `Hi/Lo: ${me.hiloChoice.toUpperCase()} ${icon} ${me.hiloCorrect ? `+${me.hiloBonus}` : '+0'}`;
      $('res-hilo').style.display = '';
    } else {
      $('res-hilo').style.display = 'none';
    }

    $('res-total').textContent = `Total score: ${me.totalScore.toLocaleString()}`;

    showScreen('screen-results');
  });

  socket.on('game-over', (data) => {
    const idx = data.scores.findIndex(s => s.id === myPlayer?.id);
    const place = idx + 1;
    const score = data.scores[idx]?.score || 0;

    const medals = ['🥇', '🥈', '🥉'];
    $('final-place').textContent = place <= 3 ? medals[place - 1] : `#${place}`;
    $('final-place-text').textContent = place === 1 ? 'YOU WIN!' : `${ordinal(place)} Place`;
    $('final-score').textContent = `${score.toLocaleString()} points`;

    showScreen('screen-final');
    if (place === 1) audio.fanfare();
    else audio.ding();
  });

  socket.on('back-to-lobby', (data) => {
    showScreen('screen-waiting');
    toggleTeamSelect();
  });

  socket.on('settings-updated', (data) => {
    if (data.gameMode) {
      gameMode = data.gameMode;
      toggleTeamSelect();
    }
  });

  socket.on('team-chosen', (data) => {
    myTeam = data.team;
    updateTeamStatus();
  });

  socket.on('kicked', () => {
    showScreen('screen-kicked');
  });

  socket.on('host-disconnected', () => {
    showScreen('screen-host-dc');
  });

  /* ── nutshell board game events ── */

  socket.on('nutshell-round-start', (data) => {
    nutshellState = { revealedIndices: [], revealedWords: {}, totalWords: data.totalWords, teamTurn: 0 };
    // Store round info for later
    nutshellState.round = data.round;
    nutshellState.totalRounds = data.totalRounds;
    nutshellState.category = data.category;
    showScreen('screen-game-starting');
  });

  socket.on('nutshell-turn', (data) => {
    nutshellState.revealedIndices = data.revealedIndices;
    nutshellState.revealedWords = data.revealedWords;
    nutshellState.totalWords = data.totalWords;
    nutshellState.teamTurn = data.teamTurn;

    const isMyTurn = myTeam === data.teamTurn;
    const roundLabel = `Round ${nutshellState.round} of ${nutshellState.totalRounds}`;
    const catLabel = `🥜 ${nutshellState.category}`;

    if (isMyTurn) {
      $('p-nutshell-round').textContent = roundLabel;
      $('p-nutshell-category').textContent = catLabel;
      $('p-nutshell-timer').textContent = '30';
      $('p-nutshell-timer').classList.remove('urgent');
      $('p-nutshell-turn-label').textContent = 'YOUR TURN!';
      $('p-nutshell-pts').textContent = data.pointsAvailable;
      updatePlayerClue();
      resetNutshellActions();
      showScreen('screen-nutshell-turn');
    } else {
      const teamName = TEAM_NAMES[data.teamTurn] || 'Other Team';
      $('p-nutshell-wait-round').textContent = roundLabel;
      $('p-nutshell-wait-category').textContent = catLabel;
      $('p-nutshell-wait-text').textContent = `${teamName} is playing...`;
      $('p-nutshell-wait-pts').textContent = data.pointsAvailable;
      updateWaitClue();
      showScreen('screen-nutshell-waiting');
    }
  });

  socket.on('nutshell-word-revealed', (data) => {
    nutshellState.revealedIndices = data.revealedIndices;
    nutshellState.revealedWords = data.revealedWords;
    audio.reveal();
  });

  socket.on('nutshell-guess-result', (data) => {
    if (data.correct) {
      $('nutshell-correct-answer').textContent = data.answer;
      $('nutshell-earned-pts').textContent = `+${data.points}`;
      showScreen('screen-nutshell-correct');
      audio.matchFound();
    } else {
      $('nutshell-feedback').textContent = data.message || 'Wrong guess!';
      $('nutshell-feedback').style.display = 'block';
      $('nutshell-feedback').className = 'nutshell-feedback wrong';

      const input = $('nutshell-guess-input');
      input.classList.add('shake-anim');
      setTimeout(() => input.classList.remove('shake-anim'), 500);
      audio.noMatch();

      // Re-enable form after brief delay (turn will pass)
      setTimeout(() => {
        $('nutshell-feedback').style.display = 'none';
      }, 2000);
    }
  });

  socket.on('nutshell-correct-guess', (data) => {
    // Everyone sees the correct guess — show who won
    if (data.team === myTeam) {
      $('nutshell-correct-answer').textContent = data.answer;
      $('nutshell-earned-pts').textContent = `+${data.points}`;
      showScreen('screen-nutshell-correct');
      audio.matchFound();
    }
  });

  socket.on('nutshell-wrong-guess', () => {
    // Just informational, turn will pass
  });

  socket.on('nutshell-turn-timeout', () => {
    // Just informational, turn will pass
  });

  socket.on('nutshell-round-results', (data) => {
    const me = data.playerResults.find(r => r.playerId === myPlayer?.id);
    if (!me) { showScreen('screen-waiting'); return; }

    $('nutshell-res-answer').textContent = data.answer;

    if (me.team === data.winningTeam && data.winningTeam) {
      $('nutshell-res-status').textContent = `✅ Your team won this round!`;
      $('nutshell-res-status').className = 'result-rank text-success';
    } else if (data.winningTeam) {
      $('nutshell-res-status').textContent = `❌ Other team got it`;
      $('nutshell-res-status').className = 'result-rank text-danger';
    } else {
      $('nutshell-res-status').textContent = `Nobody guessed it`;
      $('nutshell-res-status').className = 'result-rank text-danger';
    }

    $('nutshell-res-points').textContent = `+${me.roundScore}`;
    $('nutshell-res-total').textContent = `Total score: ${me.totalScore.toLocaleString()}`;

    showScreen('screen-nutshell-player-results');
  });

  socket.on('error-msg', (msg) => {
    console.error('Server:', msg);
  });

  /* ══════════════════
     User actions
     ══════════════════ */

  $('answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('answer-input').value.trim();
    if (!val) return;
    $('submit-btn').disabled = true;
    $('answer-input').disabled = true;
    socket.emit('submit-answer', val);
  });

  $('btn-hi').addEventListener('click', () => {
    socket.emit('submit-hilo', 'hi');
    $('btn-hi').disabled = true;
    $('btn-lo').disabled = true;
  });

  $('btn-lo').addEventListener('click', () => {
    socket.emit('submit-hilo', 'lo');
    $('btn-hi').disabled = true;
    $('btn-lo').disabled = true;
  });

  /* ── nutshell actions ── */

  $('nutshell-guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('nutshell-guess-input').value.trim();
    if (!val) return;
    $('nutshell-guess-btn').disabled = true;
    $('nutshell-guess-input').disabled = true;
    socket.emit('submit-nutshell-guess', val);
  });

  // Team selection
  [1, 2, 3].forEach(t => {
    $(`btn-team-${t}`).addEventListener('click', () => {
      socket.emit('choose-team', t);
      myTeam = t;
      updateTeamStatus();
    });
  });

  // Nutshell turn actions
  $('btn-reveal-mode').addEventListener('click', () => {
    $('nutshell-choice-btns').classList.add('hidden');
    $('nutshell-word-grid').classList.remove('hidden');
    $('nutshell-guess-area').classList.add('hidden');
    buildCardDeck();
  });

  $('btn-guess-mode').addEventListener('click', () => {
    $('nutshell-choice-btns').classList.add('hidden');
    $('nutshell-word-grid').classList.add('hidden');
    $('nutshell-guess-area').classList.remove('hidden');
    $('nutshell-guess-input').value = '';
    $('nutshell-guess-input').disabled = false;
    $('nutshell-guess-btn').disabled = false;
    $('nutshell-feedback').style.display = 'none';
    setTimeout(() => $('nutshell-guess-input').focus(), 300);
  });

  $('btn-back-to-choice').addEventListener('click', () => {
    resetNutshellActions();
  });

  $('btn-back-from-cards').addEventListener('click', () => {
    resetNutshellActions();
  });

  /* ── nutshell helpers ── */

  function toggleTeamSelect() {
    const area = $('team-select-area');
    if (!area) return;
    if (gameMode === 'nutshell') {
      area.classList.remove('hidden');
      updateTeamStatus();
    } else {
      area.classList.add('hidden');
    }
  }

  const TEAM_NAMES = { 1: 'Team Red 🔴', 2: 'Team Blue 🔵', 3: 'Team Green 🟢' };

  function updateTeamStatus() {
    const status = $('team-status');
    if (!status) return;

    [1, 2, 3].forEach(t => {
      $(`btn-team-${t}`).classList.toggle('selected', myTeam === t);
    });

    status.textContent = TEAM_NAMES[myTeam] ? `You are on ${TEAM_NAMES[myTeam]}` : 'Pick a team to play!';
  }

  function updatePlayerClue() {
    const clue = $('p-nutshell-clue');
    if (!clue) return;
    let text = '';
    for (let i = 0; i < nutshellState.totalWords; i++) {
      if (nutshellState.revealedIndices.includes(i)) {
        text += nutshellState.revealedWords[i] || '???';
      } else {
        text += '___';
      }
      if (i < nutshellState.totalWords - 1) text += ' ';
    }
    clue.textContent = text;
  }

  function updateWaitClue() {
    const clue = $('p-nutshell-wait-clue');
    if (!clue) return;
    let text = '';
    for (let i = 0; i < nutshellState.totalWords; i++) {
      if (nutshellState.revealedIndices.includes(i)) {
        text += nutshellState.revealedWords[i] || '???';
      } else {
        text += '___';
      }
      if (i < nutshellState.totalWords - 1) text += ' ';
    }
    clue.textContent = text;
  }

  function resetNutshellActions() {
    $('nutshell-choice-btns').classList.remove('hidden');
    $('nutshell-word-grid').classList.add('hidden');
    $('nutshell-guess-area').classList.add('hidden');

    // Disable reveal if all words revealed
    const allRevealed = nutshellState.revealedIndices.length >= nutshellState.totalWords;
    $('btn-reveal-mode').disabled = allRevealed;
    if (allRevealed) {
      $('btn-reveal-mode').textContent = '✅ All Cards Pulled';
    } else {
      $('btn-reveal-mode').textContent = '🃏 PULL A CARD';
    }
  }

  function buildCardDeck() {
    const grid = $('card-deck-grid');
    if (!grid) return;
    grid.innerHTML = '';
    let hasCards = false;
    for (let i = 0; i < nutshellState.totalWords; i++) {
      if (nutshellState.revealedIndices.includes(i)) continue;
      hasCards = true;
      const card = document.createElement('div');
      card.className = 'pull-card';
      card.innerHTML = `
        <div class="pull-card-inner">
          <div class="pull-card-pattern"></div>
          <span class="pull-card-num">${i + 1}</span>
        </div>
      `;
      card.addEventListener('click', () => {
        card.classList.add('pull-card-pulling');
        // Disable all cards immediately
        grid.querySelectorAll('.pull-card').forEach(c => c.style.pointerEvents = 'none');
        setTimeout(() => {
          socket.emit('reveal-word', i);
        }, 400);
      });
      grid.appendChild(card);
    }
    if (!hasCards) {
      grid.innerHTML = '<p class="text-dim">All cards pulled!</p>';
    }
  }

  /* ── util ── */
  function ordinal(n) {
    const s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
})();
