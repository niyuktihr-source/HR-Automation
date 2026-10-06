// A temporary outage of an outside service (Gemini overloaded / rate-limited, network or Google
// Drive hiccup) — as opposed to a real problem with the document itself. Callers retry these and
// must never treat them as "the document is wrong" (e.g. never email the joinee about them).
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT']);
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_TEXT = /\b(429|500|502|503|504)\b|quota|RESOURCE_EXHAUSTED|UNAVAILABLE|Service Unavailable|high demand|overloaded|try again later|rate.?limit|fetch failed|network|socket hang up|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

function isTransientServiceError(err) {
  if (!err) return false;
  const status = Number(err.status || err.code || (err.response && err.response.status));
  if (TRANSIENT_STATUS.has(status)) return true;
  if (typeof err.code === 'string' && TRANSIENT_CODES.has(err.code)) return true;
  return TRANSIENT_TEXT.test(String(err.message || ''));
}

// Retry delays: use Google's own "retryDelay" hint when present, else back off 10s, 20s, 40s.
async function retryTransient(fn, { maxRetries = 4, label = 'Gemini' } = {}) {
  let delay = 10000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientServiceError(err)) throw err;
      if (attempt >= maxRetries) {
        err.serviceUnavailable = true; // callers: retry the file later, do NOT reject it
        throw err;
      }
      const hint = String(err.message || '').match(/"retryDelay":"(\d+)s"/);
      const waitMs = hint ? parseInt(hint[1]) * 1000 + 2000 : delay;
      console.warn(`[${label}] Temporarily unavailable (${String(err.message).slice(0, 120)}) — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}/${maxRetries}`);
      await new Promise(r => setTimeout(r, waitMs));
      delay *= 2;
    }
  }
}

module.exports = { isTransientServiceError, retryTransient };
