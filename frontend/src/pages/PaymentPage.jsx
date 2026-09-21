import React, { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { getPaymentSession, payThroughSession } from "../api/paymentSessionApi";

/**
 * Format currency in INR
 */
const formatINR = (amount) => {
  if (amount === undefined || amount === null) return "₹0.00";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(amount);
};

export default function PaymentPage() {
  const { sessionId } = useParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [paymentState, setPaymentState] = useState("IDLE"); // IDLE | PROCESSING | SUCCESS | FAILED
  const [paymentInfo, setPaymentInfo] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Stable idempotency key reference per payment attempt flow (does not change on re-render)
  const idempotencyKeyRef = useRef(null);

  const getOrCreateIdempotencyKey = () => {
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = `idem-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
    return idempotencyKeyRef.current;
  };

  const resetIdempotencyKeyForRetry = () => {
    idempotencyKeyRef.current = `idem-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  };

  // Fetch session data on mount or when sessionId changes
  const fetchSession = async () => {
    try {
      setLoading(true);
      setError(null);
      setActionError(null);

      const data = await getPaymentSession(sessionId);
      setSessionData(data.session);

      // Check server state
      if (data.session.orderStatus === "paid" || data.session.sessionStatus === "completed") {
        setPaymentState("SUCCESS");
        if (data.session.latestPayment) {
          setPaymentInfo(data.session.latestPayment);
        }
      } else if (data.session.sessionStatus === "expired") {
        setPaymentState("EXPIRED");
      } else if (data.session.latestPayment?.status === "processing") {
        setPaymentState("PROCESSING");
        setPaymentInfo(data.session.latestPayment);
      } else if (data.session.latestPayment?.status === "failed") {
        setPaymentState("FAILED");
        setPaymentInfo(data.session.latestPayment);
      } else {
        setPaymentState("IDLE");
      }
    } catch (err) {
      if (err.status === 404) {
        setError("Payment session not found. Please verify the URL or scan the QR code again.");
      } else if (err.status === 410) {
        setError("This payment session has expired.");
      } else {
        setError("Unable to load payment details. Please check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionId) {
      fetchSession();
    }
  }, [sessionId]);

  // Polling mechanism while payment is in PROCESSING state
  useEffect(() => {
    let intervalId = null;

    if (paymentState === "PROCESSING") {
      intervalId = setInterval(async () => {
        try {
          const data = await getPaymentSession(sessionId);
          setSessionData(data.session);

          if (data.session.orderStatus === "paid" || data.session.sessionStatus === "completed") {
            setPaymentState("SUCCESS");
            if (data.session.latestPayment) {
              setPaymentInfo(data.session.latestPayment);
            }
          } else if (data.session.latestPayment?.status === "failed") {
            setPaymentState("FAILED");
            setPaymentInfo(data.session.latestPayment);
          } else if (data.session.sessionStatus === "expired") {
            setPaymentState("EXPIRED");
          }
        } catch (err) {
          console.error("Polling check failed:", err);
        }
      }, 2500);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [paymentState, sessionId]);

  // Handle Pay Now action
  const handlePayNow = async (simulatedResult = "success") => {
    if (paymentState === "PROCESSING") return;

    setActionError(null);
    setPaymentState("PROCESSING");

    const key = getOrCreateIdempotencyKey();

    try {
      const response = await payThroughSession(sessionId, {
        idempotencyKey: key,
        result: simulatedResult
      });

      if (response.payment) {
        setPaymentInfo(response.payment);
        if (response.payment.status === "success") {
          setPaymentState("SUCCESS");
        } else if (response.payment.status === "failed") {
          setPaymentState("FAILED");
        }
      }
    } catch (err) {
      console.error("Payment execution error:", err);
      if (err.status === 410) {
        setPaymentState("EXPIRED");
        setActionError("This payment session has expired.");
      } else if (err.status === 409) {
        setActionError(err.message || "Payment conflict occurred or order already completed.");
        fetchSession();
      } else {
        setActionError(err.message || "Payment failed. Please try again.");
        setPaymentState("FAILED");
      }
    }
  };

  // Handle Retry after failure
  const handleRetry = () => {
    resetIdempotencyKeyForRetry();
    setActionError(null);
    setPaymentState("IDLE");
  };

  // Render Loading State
  if (loading) {
    return (
      <div className="payment-container">
        <div className="payment-card">
          <div className="spinner"></div>
          <p className="loading-text">Loading payment details...</p>
        </div>
      </div>
    );
  }

  // Render Fetch Error State
  if (error) {
    return (
      <div className="payment-container">
        <div className="payment-card error-card">
          <div className="status-icon error-icon">✕</div>
          <h2>Payment Session Error</h2>
          <p className="error-message">{error}</p>
          <button className="btn btn-secondary" onClick={fetchSession}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const { orderId, amount, sessionStatus, expiresAt } = sessionData || {};
  const isExpired = sessionStatus === "expired" || paymentState === "EXPIRED";
  const isCompleted = sessionStatus === "completed" || paymentState === "SUCCESS";
  const isProcessing = paymentState === "PROCESSING";

  return (
    <div className="payment-container">
      <div className="payment-card">
        {/* Header */}
        <div className="card-header">
          <span className="badge">Payment Simulator</span>
          <h1 className="card-title">Checkout</h1>
        </div>

        {/* Order & Amount Details */}
        <div className="order-details">
          <div className="detail-row">
            <span className="detail-label">Order ID</span>
            <span className="detail-value font-mono">{orderId}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Session ID</span>
            <span className="detail-value font-mono text-sm">{sessionId}</span>
          </div>
          {expiresAt && (
            <div className="detail-row">
              <span className="detail-label">Expires</span>
              <span className="detail-value text-sm">
                {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          )}
          <hr className="divider" />
          <div className="amount-container">
            <span className="amount-label">Total Amount</span>
            <span className="amount-value">{formatINR(amount)}</span>
          </div>
        </div>

        {/* Action Error Banner */}
        {actionError && (
          <div className="alert-banner alert-error">
            <span>{actionError}</span>
          </div>
        )}

        {/* State 1: Success State */}
        {isCompleted && (
          <div className="status-box success-box">
            <div className="status-icon success-icon">✓</div>
            <h3>Payment Successful</h3>
            <p className="status-desc">Your payment has been processed and confirmed.</p>
            {paymentInfo && (
              <div className="payment-meta">
                <div>
                  <span className="meta-label">Payment ID:</span>
                  <span className="meta-value font-mono">{paymentInfo.paymentId}</span>
                </div>
                {paymentInfo.attemptNumber && (
                  <div>
                    <span className="meta-label">Attempt:</span>
                    <span className="meta-value">#{paymentInfo.attemptNumber}</span>
                  </div>
                )}
              </div>
            )}
            <div className="status-tag status-paid">ORDER PAID</div>
          </div>
        )}

        {/* State 2: Expired State */}
        {isExpired && !isCompleted && (
          <div className="status-box expired-box">
            <div className="status-icon warning-icon">!</div>
            <h3>Session Expired</h3>
            <p className="status-desc">This payment session has timed out. Please request a new QR code.</p>
            <button className="btn btn-secondary" onClick={fetchSession}>
              Refresh Status
            </button>
          </div>
        )}

        {/* State 3: Processing State */}
        {isProcessing && (
          <div className="status-box processing-box">
            <div className="spinner"></div>
            <h3>Processing Payment</h3>
            <p className="status-desc">Awaiting provider simulation and webhook confirmation. Please do not close this window.</p>
            {paymentInfo?.paymentId && (
              <p className="text-sm font-mono text-muted">ID: {paymentInfo.paymentId}</p>
            )}
          </div>
        )}

        {/* State 4: Failed State */}
        {paymentState === "FAILED" && !isCompleted && !isExpired && (
          <div className="status-box failed-box">
            <div className="status-icon error-icon">✕</div>
            <h3>Payment Failed</h3>
            <p className="status-desc">Your payment attempt was unsuccessful. You can retry with a new payment attempt.</p>
            {paymentInfo && (
              <div className="payment-meta">
                <div>
                  <span className="meta-label">Failed Attempt:</span>
                  <span className="meta-value font-mono">#{paymentInfo.attemptNumber || 1} ({paymentInfo.paymentId})</span>
                </div>
              </div>
            )}
            <div className="action-buttons">
              <button className="btn btn-primary" onClick={() => handlePayNow("success")}>
                Retry Payment
              </button>
              <button className="btn btn-secondary" onClick={handleRetry}>
                Change Options
              </button>
            </div>
          </div>
        )}

        {/* State 5: Idle / Ready to Pay */}
        {paymentState === "IDLE" && !isCompleted && !isExpired && (
          <div className="action-container">
            <button
              id="pay-now-button"
              className="btn btn-primary btn-block"
              onClick={() => handlePayNow("success")}
              disabled={isProcessing}
            >
              Pay Now {formatINR(amount)}
            </button>

            {/* Simulation Options for Testing */}
            <div className="simulator-options">
              <span className="simulator-label">Simulator Mode:</span>
              <button
                type="button"
                className="btn-link text-xs"
                onClick={() => handlePayNow("failed")}
                disabled={isProcessing}
              >
                Simulate Provider Failure
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
