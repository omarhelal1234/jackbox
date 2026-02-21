/**
 * Answer normalisation & matching utilities
 */

function normalizeAnswer(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function depluralize(word) {
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
 * Try to match a player's submission against the ranked answers for a category.
 * Returns the matched answer object ({ rank, text, ... }) or null.
 */
function findMatch(submission, categoryAnswers) {
  const norm = normalizeAnswer(submission);
  if (!norm) return null;

  const deplu = depluralize(norm);

  for (const answer of categoryAnswers) {
    const candidates = [answer.text, ...(answer.synonyms || [])];

    for (const candidate of candidates) {
      const nc = normalizeAnswer(candidate);
      const dc = depluralize(nc);

      // Exact or depluralized match
      if (norm === nc || deplu === dc || norm === dc || deplu === nc) return answer;

      // Multi-word containment (both directions)
      const normWords = norm.split(' ');
      const ncWords = nc.split(' ');

      if (normWords.length > 1 || ncWords.length > 1) {
        if (norm.includes(nc) || nc.includes(norm)) return answer;
      }
    }
  }

  return null;
}

module.exports = { normalizeAnswer, depluralize, findMatch };
