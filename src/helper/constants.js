const MAX_RETRIES = 3;
const SLA_MS = 10_000;
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000];

module.exports = {
  MAX_RETRIES,
  SLA_MS,
  RETRY_BACKOFF_MS,
};