/**
 * Tiny Web Audio sound-effects manager – no external files needed.
 */
class AudioManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  _ensure() {
    if (!this.ctx) this.init();
  }

  _tone(freq, dur, type = 'sine', vol = 0.25) {
    if (!this.enabled) return;
    this._ensure();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + dur);
  }

  tick()           { this._tone(800, 0.06, 'square', 0.10); }
  ding()           { this._tone(1200, 0.30, 'sine',   0.20); }
  buzz()           { this._tone(180, 0.35, 'sawtooth', 0.18); }
  countdown()      { this._tone(440, 0.08, 'square', 0.12); }
  countdownFinal() { this._tone(880, 0.20, 'square', 0.18); }

  reveal() {
    this._tone(523, 0.12, 'triangle', 0.22);
    setTimeout(() => this._tone(659, 0.14, 'triangle', 0.22), 100);
    setTimeout(() => this._tone(784, 0.18, 'triangle', 0.25), 200);
  }

  matchFound() {
    this._tone(784, 0.10, 'sine', 0.22);
    setTimeout(() => this._tone(1047, 0.25, 'sine', 0.28), 120);
  }

  noMatch() {
    this._tone(311, 0.25, 'sawtooth', 0.12);
  }

  fanfare() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => this._tone(f, 0.35, 'sine', 0.25), i * 160));
  }

  playerJoin() {
    this._tone(660, 0.08, 'sine', 0.15);
    setTimeout(() => this._tone(880, 0.12, 'sine', 0.18), 80);
  }

  submit() {
    this._tone(1000, 0.08, 'sine', 0.15);
  }

  roundIntro() {
    const notes = [392, 494, 587, 784];
    notes.forEach((f, i) => setTimeout(() => this._tone(f, 0.18, 'triangle', 0.20), i * 120));
  }
}
