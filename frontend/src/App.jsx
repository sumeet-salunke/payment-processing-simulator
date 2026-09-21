import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import PaymentPage from "./pages/PaymentPage";
import "./index.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/payment/:sessionId" element={<PaymentPage />} />
        {/* Default fallback */}
        <Route
          path="*"
          element={
            <div className="payment-container">
              <div className="payment-card">
                <h2>Payment Simulator</h2>
                <p className="text-muted">Please scan a QR code or visit a valid session URL (/payment/:sessionId).</p>
              </div>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
