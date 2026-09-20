export const RETRY_POLICY = Object.freeze({
  MAX_ATTEMPTS: 5,
  INITIAL_DELAY_MS: 5000, // 5 seconds
  BACKOFF_FACTOR: 2,
  MAX_DELAY_MS: 60000 // 60 seconds
});

export const calculateBackoffDelay = (attempt, initialDelay = RETRY_POLICY.INITIAL_DELAY_MS) => {
  const safeAttempt = Math.max(1, attempt);
  const delay = initialDelay * Math.pow(RETRY_POLICY.BACKOFF_FACTOR, safeAttempt - 1);
  return Math.min(delay, RETRY_POLICY.MAX_DELAY_MS);
};

export const isRetryableError = (error) => {
  // If explicitly flagged
  if (error?.isPermanent) {
    return false;
  }

  // 400 (Invalid payload/event) and 404 (Entity not found) are permanent business failures
  if (error?.statusCode === 400 || error?.statusCode === 404) {
    return false;
  }

  // 409 (state machine conflict / concurrent lock), 500+, connection timeouts, and network errors are retryable
  return true;
};
