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
    $('player-header').classList.remove('hidden');
    $('header-name').textContent = myPlayer.name;
    $('header-code').textContent = roomCode;
    showScreen('screen-waiting');
    audio.ding();
  });

  socket.on('join-error', (msg) => {
    alert(msg);
    window.location.href = '/';
  });

  socket.on('game-starting', () => {
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

  socket.on('back-to-lobby', () => {
    showScreen('screen-waiting');
  });

  socket.on('kicked', () => {
    showScreen('screen-kicked');
  });

  socket.on('host-disconnected', () => {
    showScreen('screen-host-dc');
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

  /* ── util ── */
  function ordinal(n) {
    const s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
})();
