/**
 * Client API layer for Payment Sessions
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

/**
 * Fetch a payment session by sessionId
 * @param {string} sessionId
 * @returns {Promise<Object>}
 */
export const getPaymentSession = async (sessionId) => {
  const response = await fetch(`${API_BASE_URL}/api/payment-sessions/${sessionId}`, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = data.error?.message || data.message || `Failed to fetch payment session (status ${response.status})`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data.data;
};

/**
 * Initiate payment through an active session
 * @param {string} sessionId
 * @param {Object} options
 * @param {string} [options.idempotencyKey]
 * @param {string} [options.result] - "success" | "failed" (simulator provider result)
 * @returns {Promise<Object>}
 */
export const payThroughSession = async (sessionId, { idempotencyKey, result = "success" } = {}) => {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }

  const response = await fetch(`${API_BASE_URL}/api/payment-sessions/${sessionId}/pay`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = data.error?.message || data.message || `Payment processing failed (status ${response.status})`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data.data;
};
