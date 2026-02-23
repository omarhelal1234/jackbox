const categories = require('../data/categories.json');
const nutshellPrompts = require('../data/nutshell.json');
const { findMatch } = require('./matcher');
const fs = require('fs');
const path = require('path');

/* ─── suggestion log for unfound answers ─── */
const SUGGESTIONS_PATH = path.join(__dirname, '..', 'data', 'suggestions.json');

function loadSuggestions() {
  try {
    return JSON.parse(fs.readFileSync(SUGGESTIONS_PATH, 'utf8'));
  } catch { return []; }
}

function saveSuggestion(categoryId, categoryPrompt, answer) {
  const suggestions = loadSuggestions();
  // Avoid duplicates for the same category+answer
  const exists = suggestions.some(s =>
    s.categoryId === categoryId && s.answer.toLowerCase() === answer.toLowerCase()
  );
  if (exists) return;
  suggestions.push({
    categoryId,
    categoryPrompt,
    answer,
    timestamp: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(SUGGESTIONS_PATH, JSON.stringify(suggestions, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save suggestion:', e.message);
  }
}

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
    this.categoryGroups = settings.categoryGroups || ['all'];
    this.gameMode       = settings.gameMode || 'topmatch';

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

    // nutshell-specific state (team board game)
    this.nutshellWords      = [];
    this.nutshellQuestion   = null;
    this.revealedIndices    = new Set();
    this.currentTeamTurn    = 1;

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
      categoryGroups: this.categoryGroups,
      gameMode:       this.gameMode,
    };
  }

  updateSettings(s) {
    if (this.state !== 'lobby') return;
    if (s.rounds !== undefined)         this.totalRounds    = Math.min(Math.max(parseInt(s.rounds), 3), 10);
    if (s.hilo !== undefined)           this.hiloEnabled    = !!s.hilo;
    if (s.familyFriendly !== undefined) this.familyFriendly = !!s.familyFriendly;
    if (s.answerTime !== undefined)     this.answerTime     = Math.min(Math.max(parseInt(s.answerTime), 10), 60);
    if (s.categoryGroups !== undefined) this.categoryGroups = s.categoryGroups;
    if (s.gameMode !== undefined)       this.gameMode       = s.gameMode;
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
      team:          null,
    };
    this.players.set(player.id, player);
    return { player: this._pub(player) };
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    this.emit('player-left', { playerId, name: p.name, playerCount: this.getPlayerCount() });
    if (this.state === 'round-active')       this._checkAllSubmitted();
    if (this.state === 'hilo-phase')          this._checkAllHiLo();
    if (this.state === 'nutshell-active' && this.activeTeams) {
      // If current team has no connected players, pass turn
      const teamPlayers = this._connected().filter(x => x.team === this.currentTeamTurn);
      if (teamPlayers.length === 0) {
        this.clearTimer();
        this.currentTeamTurn = this._nextTeamTurn();
        setTimeout(() => this._startNutshellTurn(), 1000);
      }
    }
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

    if (this.gameMode === 'nutshell') {
      return this._startNutshellGame();
    }

    const filtered = (!this.categoryGroups || this.categoryGroups.includes('all'))
      ? categories
      : categories.filter(c => this.categoryGroups.includes(c.group));
    if (filtered.length < this.totalRounds) throw new Error('Not enough categories for the selected groups. Select more groups or fewer rounds.');
    const shuffled = [...filtered].sort(() => Math.random() - 0.5);
    this.selectedCategories = shuffled.slice(0, this.totalRounds);
    this.currentRound = 0;
    for (const p of this.players.values()) p.score = 0;

    this.state = 'game-starting';
    this.emit('game-starting', { totalRounds: this.totalRounds, players: this._pubList(), gameMode: this.gameMode });

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

    // Validate: answer must match something in the category list
    const match = findMatch(answer, this.currentCategory.answers);
    if (!match) {
      // Save the unfound answer for future review
      saveSuggestion(this.currentCategory.id, this.currentCategory.prompt, answer);
      this.io.to(p.socketId).emit('answer-rejected', 'Not on the list — try again!');
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

    /* ── first pass: resolve matches & count duplicates ── */
    const entries = [];
    const rankCounts = {};                // rank → how many players matched it

    for (const [pid, raw] of this.answers) {
      const p = this.players.get(pid);
      if (!p) continue;

      const match = findMatch(raw, catAnswers);
      const rank  = match ? match.rank : null;

      if (rank) rankCounts[rank] = (rankCounts[rank] || 0) + 1;

      entries.push({ pid, p, raw, match, rank });
    }

    /* ── second pass: compute scores, dividing among duplicates ── */
    for (const { pid, p, raw, match, rank } of entries) {
      const basePoints = rank ? (SCORE_TABLE[rank] || 0) : CONSOLATION;
      const splitCount = rank ? (rankCounts[rank] || 1) : 1;
      const points     = Math.round(basePoints / splitCount);

      const hilo       = this.hiloChoices.get(pid) || null;
      let hiloCorrect  = false;
      let hiloBonus    = 0;

      if (this.hiloEnabled && hilo && rank) {
        hiloCorrect = (hilo === 'hi' && rank <= 5) || (hilo === 'lo' && rank > 5);
        hiloBonus   = hiloCorrect ? Math.round(HILO_BONUS / splitCount) : 0;
      }

      const roundScore = points + hiloBonus;
      p.score += roundScore;

      playerResults.push({
        playerId: pid, name: p.name, color: p.color,
        answer: raw, matchedRank: rank, matchedAnswer: match ? match.text : null,
        points, hiloChoice: hilo, hiloCorrect, hiloBonus,
        roundScore, totalScore: p.score,
        split: splitCount > 1,
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
      if (this.gameMode === 'nutshell') {
        this._startNutshellRound();
      } else {
        this._startRound();
      }
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
    this.nutshellWords = [];
    this.nutshellQuestion = null;
    this.revealedIndices = new Set();
    this.currentTeamTurn = 1;
    this.activeTeams = [1, 2];
    this.clearTimer();
    for (const p of this.players.values()) {
      p.score = 0; p.hasSubmitted = false; p.hasChosenHiLo = false;
      // keep p.team
    }
    this.emit('back-to-lobby', { players: this._pubList(), teams: this._getTeams() });
  }

  /* ══════════════════════════════
     NUTSHELL MODE  –  Team Board Game
     ══════════════════════════════ */

  /* ── team management ── */

  chooseTeam(playerId, teamNum) {
    if (this.state !== 'lobby') return;
    const p = this.players.get(playerId);
    if (!p) return;
    if (![1, 2, 3].includes(teamNum)) return;
    p.team = teamNum;
    this.io.to(p.socketId).emit('team-chosen', { team: teamNum });
    this.emit('teams-updated', this._getTeams());
  }

  _getTeams() {
    const team1 = [], team2 = [], team3 = [], unassigned = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const pub = this._pub(p);
      if (p.team === 1) team1.push(pub);
      else if (p.team === 2) team2.push(pub);
      else if (p.team === 3) team3.push(pub);
      else unassigned.push(pub);
    }
    return { team1, team2, team3, unassigned };
  }

  _startNutshellGame() {
    const teams = this._getTeams();
    const activeTeams = [1, 2, 3].filter(t => teams[`team${t}`].length > 0);
    if (activeTeams.length < 2) {
      throw new Error('At least 2 teams need players!');
    }
    this.activeTeams = activeTeams;

    const shuffled = [...nutshellPrompts].sort(() => Math.random() - 0.5);
    if (shuffled.length < this.totalRounds) throw new Error('Not enough questions.');
    this.selectedCategories = shuffled.slice(0, this.totalRounds);
    this.currentRound = 0;
    for (const p of this.players.values()) p.score = 0;

    this.state = 'game-starting';
    this.emit('game-starting', {
      totalRounds: this.totalRounds,
      players: this._pubList(),
      gameMode: 'nutshell',
      teams: this._getTeams(),
    });
    setTimeout(() => this._startNutshellRound(), 3500);
  }

  _startNutshellRound() {
    this.currentRound++;
    this.nutshellQuestion = this.selectedCategories[this.currentRound - 1];
    this.nutshellWords = this.nutshellQuestion.question.split(/\s+/);
    this.revealedIndices = new Set();
    this.currentTeamTurn = this.activeTeams[(this.currentRound - 1) % this.activeTeams.length];
    this.clearTimer();

    this.state = 'nutshell-active';

    this.emit('nutshell-round-start', {
      round:       this.currentRound,
      totalRounds: this.totalRounds,
      category:    this.nutshellQuestion.category,
      totalWords:  this.nutshellWords.length,
      teams:       this._getTeams(),
    });

    setTimeout(() => this._startNutshellTurn(), 2500);
  }

  _nextTeamTurn() {
    const idx = this.activeTeams.indexOf(this.currentTeamTurn);
    return this.activeTeams[(idx + 1) % this.activeTeams.length];
  }

  _startNutshellTurn() {
    if (this.state !== 'nutshell-active') return;

    // Check if current team has connected players, cycle to find one
    let attempts = 0;
    while (attempts < this.activeTeams.length) {
      const teamPlayers = this._connected().filter(p => p.team === this.currentTeamTurn);
      if (teamPlayers.length > 0) break;
      this.currentTeamTurn = this._nextTeamTurn();
      attempts++;
    }
    if (attempts >= this.activeTeams.length) {
      this._endNutshellRound(null, 0, null);
      return;
    }

    const totalWords = this.nutshellWords.length;
    const revealedCount = this.revealedIndices.size;
    const allRevealed = revealedCount >= totalWords;

    this.emit('nutshell-turn', {
      teamTurn:        this.currentTeamTurn,
      revealedIndices: [...this.revealedIndices],
      revealedWords:   this._getRevealedWords(),
      totalWords,
      pointsAvailable: this._nutshellPoints(revealedCount, totalWords),
      allRevealed,
    });

    // Turn timer: 30 seconds
    this._startTimer(30, () => {
      this.emit('nutshell-turn-timeout', { team: this.currentTeamTurn });
      this.currentTeamTurn = this._nextTeamTurn();
      setTimeout(() => this._startNutshellTurn(), 1500);
    });
  }

  _getRevealedWords() {
    const words = {};
    for (const idx of this.revealedIndices) {
      words[idx] = this.nutshellWords[idx];
    }
    return words;
  }

  _nutshellPoints(revealedCount, totalWords) {
    if (totalWords <= 1) return 1000;
    const ratio = (totalWords - revealedCount) / totalWords;
    return Math.max(100, Math.round(1000 * ratio));
  }

  /* ── nutshell: reveal a word ── */

  revealWord(playerId, wordIndex) {
    if (this.state !== 'nutshell-active') return;
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    if (p.team !== this.currentTeamTurn) return;
    if (this.revealedIndices.has(wordIndex)) return;
    if (wordIndex < 0 || wordIndex >= this.nutshellWords.length) return;

    this.clearTimer();
    this.revealedIndices.add(wordIndex);

    const totalWords = this.nutshellWords.length;
    const revealedCount = this.revealedIndices.size;

    this.emit('nutshell-word-revealed', {
      wordIndex,
      word: this.nutshellWords[wordIndex],
      revealedByTeam: this.currentTeamTurn,
      revealedByName: p.name,
      revealedIndices: [...this.revealedIndices],
      revealedWords:   this._getRevealedWords(),
      pointsAvailable: this._nutshellPoints(revealedCount, totalWords),
      allRevealed:     revealedCount >= totalWords,
    });

    // Pass turn to next team
    this.currentTeamTurn = this._nextTeamTurn();
    setTimeout(() => this._startNutshellTurn(), 1500);
  }

  /* ── nutshell: guess submission ── */

  submitNutshellGuess(playerId, raw) {
    if (this.state !== 'nutshell-active') return;
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    if (p.team !== this.currentTeamTurn) return;

    const guess = (raw || '').trim().substring(0, 80);
    if (!guess) return;
    if (this.familyFriendly && isProfane(guess)) {
      this.io.to(p.socketId).emit('nutshell-guess-result', { correct: false, message: 'Keep it family-friendly!' });
      return;
    }

    const correct = this._checkNutshellAnswer(guess, this.nutshellQuestion);

    if (correct) {
      this.clearTimer();
      const revealedCount = this.revealedIndices.size;
      const totalWords = this.nutshellWords.length;
      const points = this._nutshellPoints(revealedCount, totalWords);
      const winningTeam = this.currentTeamTurn;

      // Award points to all members of the winning team
      for (const tp of this.players.values()) {
        if (tp.team === winningTeam && tp.connected) tp.score += points;
      }

      this.emit('nutshell-correct-guess', {
        team:          winningTeam,
        playerName:    p.name,
        answer:        this.nutshellQuestion.answer,
        points,
        revealedCount,
        totalWords,
      });

      this.io.to(p.socketId).emit('nutshell-guess-result', {
        correct: true, points, answer: this.nutshellQuestion.answer,
      });

      setTimeout(() => this._endNutshellRound(winningTeam, points, p.name), 3000);
    } else {
      this.clearTimer();

      this.io.to(p.socketId).emit('nutshell-guess-result', {
        correct: false,
        message: 'Wrong guess! Turn passes to the other team.',
      });

      this.emit('nutshell-wrong-guess', {
        team: this.currentTeamTurn,
        playerName: p.name,
      });

      // Pass turn
      this.currentTeamTurn = this._nextTeamTurn();
      setTimeout(() => this._startNutshellTurn(), 2000);
    }
  }

  _checkNutshellAnswer(guess, question) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const g = norm(guess);
    if (!g) return false;

    for (const accepted of question.accept) {
      const a = norm(accepted);
      if (g === a) return true;
      if (g.includes(a) || a.includes(g)) return true;
      if (a.length >= 4 && this._levenshtein(g, a) <= Math.max(1, Math.floor(a.length * 0.25))) return true;
    }
    return false;
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  /* ── nutshell: round end & results ── */

  _endNutshellRound(winningTeam, points, guessedBy) {
    if (this.state !== 'nutshell-active') return;
    this.clearTimer();

    const playerResults = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const isWinner = p.team === winningTeam;
      playerResults.push({
        playerId: p.id, name: p.name, color: p.color, team: p.team,
        roundScore: isWinner ? points : 0,
        totalScore: p.score,
      });
    }
    playerResults.sort((a, b) => b.totalScore - a.totalScore);

    // Team totals
    let team1Total = 0, team2Total = 0, team3Total = 0;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (p.team === 1) team1Total += p.score;
      if (p.team === 2) team2Total += p.score;
      if (p.team === 3) team3Total += p.score;
    }

    const results = {
      round:        this.currentRound,
      totalRounds:  this.totalRounds,
      category:     this.nutshellQuestion.category,
      question:     this.nutshellQuestion.question,
      answer:       this.nutshellQuestion.answer,
      totalWords:   this.nutshellWords.length,
      revealedCount: this.revealedIndices.size,
      winningTeam,
      points,
      guessedBy,
      playerResults,
      scores:       this._scoreboard(),
      teamScores:   { team1: team1Total, team2: team2Total, team3: team3Total },
      activeTeams:  this.activeTeams || [1, 2],
      isLastRound:  this.currentRound >= this.totalRounds,
    };

    this.roundResults = results;
    this.emit('nutshell-round-results', results);
    this.state = 'round-scores';
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

  _pub(p) { return { id: p.id, name: p.name, color: p.color, score: p.score, team: p.team || null }; }

  getPlayerState() {
    return {
      state:        this.state,
      players:      this._pubList(),
      currentRound: this.currentRound,
      totalRounds:  this.totalRounds,
      settings:     this.getSettings(),
      teams:        this._getTeams(),
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
