const categories = require('../data/categories.json');
const { findMatch } = require('./matcher');

/* ─── constants ─── */
const PLAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#00bcd4',
  '#e91e63', '#8bc34a', '#ff5722', '#607d8b',
];

const SCORE_TABLE = {
  1: 1000, 2: 800, 3: 650, 4: 500,
  5: 350,  6: 250, 7: 100, 8: 100,
  9: 100,  10: 100,
};
const HILO_BONUS = 200;
const CONSOLATION = 0;

const PROFANE = [
  'fuck','shit','bitch','dick','cock','pussy','bastard',
  'slut','whore','nigger','nigga','faggot','fag','retard',
];

function isProfane(text) {
  if (!text) return false;
  const lower = text.toLowerCase().replace(/[^a-z]/g, '');
  return PROFANE.some(w => lower.includes(w));
}

/* ─── Room class ─── */
class Room {
  constructor(hostSocketId, settings, io) {
    this.code        = Room.generateCode();
    this.hostId      = hostSocketId;
    this.io          = io;
    this.createdAt   = Date.now();

    // settings
    this.totalRounds    = Math.min(Math.max(parseInt(settings.rounds) || 6, 3), 10);
    this.hiloEnabled    = settings.hilo !== false;
    this.familyFriendly = settings.familyFriendly !== false;
    this.answerTime     = parseInt(settings.answerTime) || 20;

    // state
    this.players            = new Map();
    this.state              = 'lobby';
    this.currentRound       = 0;
    this.selectedCategories = [];
    this.currentCategory    = null;
    this.answers            = new Map();
    this.hiloChoices        = new Map();
    this.roundResults       = null;
    this.timer              = null;
    this.timerSeconds       = 0;

    this._nextPlayerId = 1;
    this._colorIndex   = 0;
  }

  /* ── static helpers ── */

  static generateCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  /* ── settings ── */

  getSettings() {
    return {
      totalRounds:    this.totalRounds,
      hiloEnabled:    this.hiloEnabled,
      familyFriendly: this.familyFriendly,
      answerTime:     this.answerTime,
    };
  }

  updateSettings(s) {
    if (this.state !== 'lobby') return;
    if (s.rounds !== undefined)         this.totalRounds    = Math.min(Math.max(parseInt(s.rounds), 3), 10);
    if (s.hilo !== undefined)           this.hiloEnabled    = !!s.hilo;
    if (s.familyFriendly !== undefined) this.familyFriendly = !!s.familyFriendly;
    if (s.answerTime !== undefined)     this.answerTime     = Math.min(Math.max(parseInt(s.answerTime), 10), 60);
    this.emit('settings-updated', this.getSettings());
  }

  /* ── players ── */

  addPlayer(socketId, name) {
    if (this.state !== 'lobby') return { error: 'Game already in progress' };
    if (this.players.size >= 12)  return { error: 'Room is full (max 12 players)' };

    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) return { error: 'That name is taken – pick another.' };
    }
    if (this.familyFriendly && isProfane(name)) return { error: 'Please choose an appropriate name.' };

    const player = {
      id:            `p${this._nextPlayerId++}`,
      socketId,
      name:          name.substring(0, 16),
      score:         0,
      color:         PLAYER_COLORS[this._colorIndex++ % PLAYER_COLORS.length],
      connected:     true,
      hasSubmitted:  false,
      hasChosenHiLo: false,
    };
    this.players.set(player.id, player);
    return { player: this._pub(player) };
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    this.emit('player-left', { playerId, name: p.name, playerCount: this.getPlayerCount() });
    if (this.state === 'round-active')  this._checkAllSubmitted();
    if (this.state === 'hilo-phase')    this._checkAllHiLo();
  }

  kickPlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.io.to(p.socketId).emit('kicked');
    this.players.delete(playerId);
    this.emit('player-kicked', { playerId, name: p.name, playerCount: this.getPlayerCount() });
  }

  getPlayerCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  _connected() {
    return [...this.players.values()].filter(p => p.connected);
  }

  isEmpty() { return this.getPlayerCount() === 0 && !this.hostId; }

  cleanup() { this.clearTimer(); }

  hostDisconnected() {
    this.hostId = null;
    this.emit('host-disconnected');
  }

  /* ── game flow ── */

  startGame() {
    if (this.state !== 'lobby') throw new Error('Not in lobby');
    if (this.getPlayerCount() < 2) throw new Error('Need at least 2 players');

    const shuffled = [...categories].sort(() => Math.random() - 0.5);
    this.selectedCategories = shuffled.slice(0, this.totalRounds);
    this.currentRound = 0;
    for (const p of this.players.values()) p.score = 0;

    this.state = 'game-starting';
    this.emit('game-starting', { totalRounds: this.totalRounds, players: this._pubList() });

    setTimeout(() => this._startRound(), 3500);
  }

  _startRound() {
    this.currentRound++;
    this.currentCategory = this.selectedCategories[this.currentRound - 1];
    this.answers.clear();
    this.hiloChoices.clear();
    for (const p of this.players.values()) { p.hasSubmitted = false; p.hasChosenHiLo = false; }

    this.state = 'round-active';
    this.emit('round-start', {
      round:      this.currentRound,
      totalRounds: this.totalRounds,
      category:   this.currentCategory.prompt,
      answerTime: this.answerTime,
    });

    this._startTimer(this.answerTime, () => this._endAnswerPhase());
  }

  /* ── answer submission ── */

  submitAnswer(playerId, raw) {
    if (this.state !== 'round-active') return;
    const p = this.players.get(playerId);
    if (!p || !p.connected || p.hasSubmitted) return;

    const answer = (raw || '').trim().substring(0, 50);
    if (!answer) return;
    if (this.familyFriendly && isProfane(answer)) {
      this.io.to(p.socketId).emit('answer-rejected', 'Keep it family-friendly!');
      return;
    }

    p.hasSubmitted = true;
    this.answers.set(playerId, answer);
    this.io.to(p.socketId).emit('answer-received', { answer });

    const sub = this._connected().filter(x => x.hasSubmitted).length;
    this.io.to(this.hostId).emit('submission-update', { submitted: sub, total: this.getPlayerCount() });

    this._checkAllSubmitted();
  }

  _checkAllSubmitted() {
    const c = this._connected();
    if (c.length > 0 && c.every(p => p.hasSubmitted)) {
      this.clearTimer();
      this._endAnswerPhase();
    }
  }

  _endAnswerPhase() {
    if (this.state !== 'round-active') return;
    this.emit('answers-locked');

    if (this.hiloEnabled) {
      this.state = 'hilo-phase';
      this.emit('hilo-phase', { time: 10 });
      this._startTimer(10, () => this._endHiLoPhase());
    } else {
      this._processResults();
    }
  }

  /* ── Hi / Lo ── */

  submitHiLo(playerId, prediction) {
    if (this.state !== 'hilo-phase') return;
    const p = this.players.get(playerId);
    if (!p || !p.connected || p.hasChosenHiLo) return;
    if (prediction !== 'hi' && prediction !== 'lo') return;

    p.hasChosenHiLo = true;
    this.hiloChoices.set(playerId, prediction);
    this.io.to(p.socketId).emit('hilo-received', { prediction });
    this._checkAllHiLo();
  }

  _checkAllHiLo() {
    const submitted = this._connected().filter(p => p.hasSubmitted);
    if (submitted.length > 0 && submitted.every(p => p.hasChosenHiLo)) {
      this.clearTimer();
      this._endHiLoPhase();
    }
  }

  _endHiLoPhase() {
    if (this.state !== 'hilo-phase') return;
    this._processResults();
  }

  /* ── scoring & reveal ── */

  _processResults() {
    this.state = 'revealing';
    const catAnswers = this.currentCategory.answers;
    const playerResults = [];

    for (const [pid, raw] of this.answers) {
      const p = this.players.get(pid);
      if (!p) continue;

      const match      = findMatch(raw, catAnswers);
      const rank       = match ? match.rank : null;
      const points     = rank ? (SCORE_TABLE[rank] || 0) : CONSOLATION;
      const hilo       = this.hiloChoices.get(pid) || null;
      let hiloCorrect  = false;
      let hiloBonus    = 0;

      if (this.hiloEnabled && hilo && rank) {
        hiloCorrect = (hilo === 'hi' && rank <= 5) || (hilo === 'lo' && rank > 5);
        hiloBonus   = hiloCorrect ? HILO_BONUS : 0;
      }

      const roundScore = points + hiloBonus;
      p.score += roundScore;

      playerResults.push({
        playerId: pid, name: p.name, color: p.color,
        answer: raw, matchedRank: rank, matchedAnswer: match ? match.text : null,
        points, hiloChoice: hilo, hiloCorrect, hiloBonus,
        roundScore, totalScore: p.score,
      });
    }

    // players who didn't submit
    for (const p of this.players.values()) {
      if (!this.answers.has(p.id) && p.connected) {
        playerResults.push({
          playerId: p.id, name: p.name, color: p.color,
          answer: null, matchedRank: null, matchedAnswer: null,
          points: 0, hiloChoice: null, hiloCorrect: false, hiloBonus: 0,
          roundScore: 0, totalScore: p.score,
        });
      }
    }

    const rankedAnswers = catAnswers.map(a => ({
      rank: a.rank,
      text: a.text,
      points: SCORE_TABLE[a.rank] || 0,
      matchedPlayers: playerResults
        .filter(pr => pr.matchedRank === a.rank)
        .map(pr => ({ id: pr.playerId, name: pr.name, color: pr.color })),
    }));

    playerResults.sort((a, b) => b.roundScore - a.roundScore);

    const results = {
      round:         this.currentRound,
      totalRounds:   this.totalRounds,
      category:      this.currentCategory.prompt,
      rankedAnswers,
      playerResults,
      scores:        this._scoreboard(),
      isLastRound:   this.currentRound >= this.totalRounds,
    };

    this.roundResults = results;
    this.emit('round-results', results);
    this.state = 'round-scores';
  }

  /* ── round / game advancement ── */

  advanceToNextRound() {
    if (this.state !== 'round-scores') return;
    if (this.currentRound >= this.totalRounds) {
      this._endGame();
    } else {
      this._startRound();
    }
  }

  _endGame() {
    this.state = 'game-over';
    this.emit('game-over', { scores: this._scoreboard(), totalRounds: this.totalRounds });
  }

  playAgain() {
    this.state       = 'lobby';
    this.currentRound = 0;
    this.selectedCategories = [];
    this.currentCategory = null;
    this.answers.clear();
    this.hiloChoices.clear();
    this.clearTimer();
    for (const p of this.players.values()) {
      p.score = 0; p.hasSubmitted = false; p.hasChosenHiLo = false;
    }
    this.emit('back-to-lobby', { players: this._pubList() });
  }

  /* ── helpers ── */

  _scoreboard() {
    return [...this.players.values()]
      .filter(p => p.connected)
      .map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  _pubList() {
    return [...this.players.values()].filter(p => p.connected).map(p => this._pub(p));
  }

  _pub(p) { return { id: p.id, name: p.name, color: p.color, score: p.score }; }

  getPlayerState() {
    return {
      state:        this.state,
      players:      this._pubList(),
      currentRound: this.currentRound,
      totalRounds:  this.totalRounds,
      settings:     this.getSettings(),
    };
  }

  emit(ev, data) { this.io.to(this.code).emit(ev, data); }

  _startTimer(seconds, cb) {
    this.clearTimer();
    this.timerSeconds = seconds;
    this.timer = setInterval(() => {
      this.timerSeconds--;
      this.emit('timer-tick', { seconds: this.timerSeconds });
      if (this.timerSeconds <= 0) { this.clearTimer(); cb(); }
    }, 1000);
  }

  clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

module.exports = Room;
