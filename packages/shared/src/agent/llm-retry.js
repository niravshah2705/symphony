'use strict';

/**
 * Retry for transient / in-stream LLM errors.
 *
 * The provider SDKs retry connection-level and pre-response failures (their own
 * `maxRetries`), but NOT an error that arrives AFTER a successful `200` — e.g.
 * OpenAI's streaming layer throws an `APIError` (with no HTTP status) when the
 * SSE body carries an `error` event mid-generation ("An error occurred while
 * processing your request"). Those surface straight through LangChain to the
 * caller and are exactly the flaky failures worth one more attempt.
 *
 * This module is provider-agnostic and side-effect free (logging is injected via
 * `onRetry`) so it stays pure and testable. `runWithRetry` wraps a `_generate`
 * (aggregated) call; `streamWithRetry` wraps a streaming generator and only
 * retries BEFORE the first chunk is yielded — once tokens have reached the
 * caller, re-running would duplicate output, so the error is rethrown.
 */

// HTTP statuses worth retrying (transient server/rate-limit/timeout conditions).
// 4xx client errors other than 408/409/429 are deliberately excluded — retrying
// a 400/401/404 just repeats a deterministic failure.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

// Socket/connection error codes that can interrupt an in-flight stream.
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function statusOf(err) {
  if (!err) return undefined;
  return err.status ?? err.statusCode ?? (err.response && err.response.status);
}

function codeOf(err) {
  if (!err) return undefined;
  return err.code || (err.cause && err.cause.code);
}

/**
 * Whether an error looks transient and safe to retry.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableStreamError(err) {
  if (!err) return false;
  const status = Number(statusOf(err));
  if (Number.isFinite(status) && RETRYABLE_STATUS.has(status)) return true;
  // A provider stream `error` event surfaces as an APIError with NO HTTP status
  // (the request already returned 200). This is the specific gap SDK retries miss.
  const name = err.name || (err.constructor && err.constructor.name) || '';
  if ((name === 'APIError' || name === 'OpenAIError') && !Number.isFinite(status)) return true;
  if (RETRYABLE_CODES.has(codeOf(err))) return true;
  return false;
}

/**
 * Run an awaitable, retrying up to `retries` times on a transient error.
 * @param {() => Promise<any>} fn
 * @param {number} retries    additional attempts after the first (0 = no retry)
 * @param {(err: unknown, attempt: number) => void} [onRetry]
 */
async function runWithRetry(fn, retries, onRetry) {
  const max = Number.isFinite(Number(retries)) ? Math.max(0, Math.floor(Number(retries))) : 0;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= max || !isRetryableStreamError(err)) throw err;
      attempt += 1;
      if (onRetry) onRetry(err, attempt);
    }
  }
}

/**
 * Wrap a streaming generator, retrying only until the first chunk is yielded.
 * `makeStream` MUST return a FRESH async iterable each call (a new request).
 * @param {() => AsyncIterable<any>} makeStream
 * @param {number} retries
 * @param {(err: unknown, attempt: number) => void} [onRetry]
 */
async function* streamWithRetry(makeStream, retries, onRetry) {
  const max = Number.isFinite(Number(retries)) ? Math.max(0, Math.floor(Number(retries))) : 0;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    let yielded = false;
    try {
      for await (const chunk of makeStream()) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // Never retry once output has started (would duplicate emitted tokens).
      if (yielded || attempt >= max || !isRetryableStreamError(err)) throw err;
      attempt += 1;
      if (onRetry) onRetry(err, attempt);
    }
  }
}

module.exports = {
  isRetryableStreamError,
  runWithRetry,
  streamWithRetry,
};
