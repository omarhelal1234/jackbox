/**
 * Answer normalisation & matching utilities
 * Supports English, Arabic, and Franco Arabic text
 */

/* ── Franco Arabic → Arabic transliteration ── */

const FRANCO_MAP = [
  // Multi-char patterns first (order matters)
  ['sh', 'ش'], ['ch', 'ش'], ['kh', 'خ'], ['gh', 'غ'], ['th', 'ث'],
  ['dh', 'ذ'], ['3a', 'عا'], ['3e', 'عي'], ['3i', 'عي'], ['3o', 'عو'], ['3u', 'عو'],
  ['ou', 'و'], ['oo', 'و'], ['ee', 'ي'], ['ei', 'ي'], ['ai', 'ي'],
  ['aa', 'ا'],
  // Numbers as Arabic letters
  ['2', 'أ'], ['3', 'ع'], ['5', 'خ'], ['6', 'ط'], ['7', 'ح'], ['8', 'ق'], ['9', 'ص'],
  // Single letters
  ['a', 'ا'], ['b', 'ب'], ['t', 'ت'], ['g', 'ج'], ['j', 'ج'],
  ['h', 'ه'], ['d', 'د'], ['r', 'ر'], ['z', 'ز'], ['s', 'س'],
  ['f', 'ف'], ['q', 'ق'], ['k', 'ك'], ['l', 'ل'], ['m', 'م'],
  ['n', 'ن'], ['w', 'و'], ['y', 'ي'], ['i', 'ي'], ['e', 'ا'],
  ['o', 'و'], ['u', 'و'], ['p', 'ب'], ['v', 'ف'],
];

function francoToArabic(text) {
  if (!text) return '';
  let result = text.toLowerCase().trim();

  // Apply multi-char replacements first, then single-char
  for (const [franco, arabic] of FRANCO_MAP) {
    result = result.split(franco).join(arabic);
  }

  // Remove any remaining non-Arabic chars (leftover numbers, punctuation)
  result = result.replace(/[^\\u0600-\\u06FF\\s]/g, '');
  return result.replace(/\\s+/g, ' ').trim();
}

/**
 * Check if input looks like Franco Arabic (Latin text with Arabic-style number usage)
 */
function isFrancoArabic(text) {
  // Contains Latin letters and possibly numbers like 2,3,5,7,8,9
  return /^[a-z0-9\s']+$/i.test(text) && text.length > 0;
}

/* ── Arabic normalisation helpers ── */

// Remove Arabic diacritics (tashkeel): fatha, damma, kasra, shadda, sukun, etc.
function stripTashkeel(text) {
  return text.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '');
}

// Normalize common Arabic letter variations
function normalizeArabicLetters(text) {
  return text
    // Alef variants → bare alef
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')   // آ أ إ ٱ → ا
    // Taa marbuta → haa
    .replace(/\u0629/g, '\u0647')                         // ة → ه
    // Alef maqsura → yaa
    .replace(/\u0649/g, '\u064A')                         // ى → ي
    // Waw with hamza → waw
    .replace(/\u0624/g, '\u0648')                         // ؤ → و
    // Yaa with hamza → yaa
    .replace(/\u0626/g, '\u064A');                        // ئ → ي
}

function isArabic(text) {
  return /[\u0600-\u06FF]/.test(text);
}

function normalizeAnswer(text) {
  if (!text) return '';
  let t = text.trim().toLowerCase();

  // Strip Arabic diacritics and normalize letter forms
  t = stripTashkeel(t);
  t = normalizeArabicLetters(t);

  // Remove everything that is NOT: a-z, 0-9, Arabic letters, or whitespace
  t = t.replace(/[^a-z0-9\u0600-\u06FF\s]/g, '');

  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Remove common Arabic prefixes (ال - "the")
  t = t.replace(/^ال/, '');

  return t;
}

function depluralize(word) {
  // Skip depluralization for Arabic words
  if (isArabic(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('sses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
  if (word.endsWith('ves') && word.length > 4) return word.slice(0, -3) + 'f';
  if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && word.length > 2) return word.slice(0, -1);
  return word;
}

function tokensMatch(a, b) {
  if (a === b) return true;
  if (depluralize(a) === depluralize(b)) return true;
  return false;
}

/**
 * Simple Levenshtein distance for fuzzy matching
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
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

/**
 * Try to match a player's submission against the ranked answers for a category.
 * Returns the matched answer object ({ rank, text, ... }) or null.
 */
function findMatch(submission, categoryAnswers) {
  const norm = normalizeAnswer(submission);
  if (!norm) return null;

  const deplu = depluralize(norm);
  const isAr = isArabic(norm);

  // Also try matching with ال prefix for Arabic
  const normWithAl = isAr ? '\u0627\u0644' + norm : null;

  // If input looks like Franco Arabic, generate Arabic version
  const francoAttempt = (!isAr && isFrancoArabic(submission))
    ? normalizeAnswer(francoToArabic(submission))
    : null;
  const francoWithAl = francoAttempt ? '\u0627\u0644' + francoAttempt : null;

  for (const answer of categoryAnswers) {
    const candidates = [answer.text, ...(answer.synonyms || [])];

    for (const candidate of candidates) {
      const nc = normalizeAnswer(candidate);
      const dc = depluralize(nc);

      // Exact or depluralized match
      if (norm === nc || deplu === dc || norm === dc || deplu === nc) return answer;

      // Match with/without ال prefix
      if (normWithAl && (normWithAl === nc || nc === norm)) return answer;
      if (isAr) {
        const ncWithoutAl = nc.replace(/^ال/, '');
        if (norm === ncWithoutAl || ncWithoutAl === norm) return answer;
      }

      // Franco Arabic → Arabic matching
      if (francoAttempt) {
        const ncWithoutAl = nc.replace(/^ال/, '');
        if (francoAttempt === nc || francoAttempt === ncWithoutAl) return answer;
        if (francoWithAl === nc) return answer;
        // Fuzzy match Franco conversion (allow more tolerance for transliteration imprecision)
        const maxFrancoDist = nc.length <= 3 ? 1 : nc.length <= 6 ? 2 : 3;
        if (levenshtein(francoAttempt, nc) <= maxFrancoDist) return answer;
        if (levenshtein(francoAttempt, ncWithoutAl) <= maxFrancoDist) return answer;
      }

      // Multi-word containment (both directions)
      const normWords = norm.split(' ');
      const ncWords = nc.split(' ');

      if (normWords.length > 1 || ncWords.length > 1) {
        if (norm.includes(nc) || nc.includes(norm)) return answer;
      }

      // Fuzzy matching: allow small typos based on word length
      const maxDist = nc.length <= 3 ? 0 : nc.length <= 6 ? 1 : 2;
      if (maxDist > 0 && levenshtein(norm, nc) <= maxDist) return answer;
    }
  }

  return null;
}

module.exports = { normalizeAnswer, depluralize, findMatch, francoToArabic, isFrancoArabic };
