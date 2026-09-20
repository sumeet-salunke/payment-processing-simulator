import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";

import idempotencyService from "../src/services/idempotency.service.js";
import idempotencyKeyRepository from "../src/repositories/idempotencyKey.repository.js";
import { IDEMPOTENCY_STATUS } from "../constants/idempotency.constants.js";
import failureSimulationService from "../src/services/failureSimulation.service.js";
import { FAILURE_MODES } from "../src/constants/failureSimulation.constants.js";
import { generatePaymentID } from "../src/helpers/generatePaymentID.js";

describe("Client Request Idempotency Tests", () => {
  beforeEach(() => {
    failureSimulationService.reset();
  });

  describe("Test A: First Request with New Idempotency-Key", () => {
    it("should process the request, store the response, and mark the record COMPLETED", async () => {
      const key = `idem-${Date.now()}-A`;
      const paymentId = generatePaymentID();
      let executionCount = 0;

      const result = await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        async () => {
          executionCount++;
          return { message: "Payment processed successfully", data: { paymentId, status: "success" } };
        }
      );

      assert.equal(result.isCached, false);
      assert.equal(result.statusCode, 200);
      assert.equal(executionCount, 1);

      const record = await idempotencyKeyRepository.findByKey(key);
      assert.ok(record, "Idempotency record must be stored");
      assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED);
      assert.equal(record.paymentId, paymentId);
      assert.equal(record.response.data.status, "success");
    });
  });

  describe("Test B: Duplicate Successful Request", () => {
    it("should replay the stored response without re-executing business logic", async () => {
      const key = `idem-${Date.now()}-B`;
      const paymentId = generatePaymentID();
      let executionCount = 0;

      const executeBusinessLogic = async () => {
        executionCount++;
        return { message: "Payment processed successfully", data: { paymentId, status: "success" } };
      };

      // Request 1: initial execution
      const res1 = await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        executeBusinessLogic
      );
      assert.equal(res1.isCached, false);
      assert.equal(executionCount, 1);

      // Request 2: duplicate request
      const res2 = await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        executeBusinessLogic
      );
      assert.equal(res2.isCached, true, "Response must be retrieved from cache");
      assert.equal(executionCount, 1, "Business logic must NOT run a second time");
      assert.deepEqual(res1.response, res2.response);

      // Request 3: another duplicate request
      const res3 = await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        executeBusinessLogic
      );
      assert.equal(res3.isCached, true);
      assert.equal(executionCount, 1, "Business logic must still only have run once");
    });
  });

  describe("Test C: Concurrent Duplicate Requests", () => {
    it("should execute business logic exactly once when multiple requests race on the same key", async () => {
      const key = `idem-${Date.now()}-C`;
      const paymentId = generatePaymentID();
      let executionCount = 0;

      const executeBusinessLogic = async () => {
        // Simulate minor async work (50ms) to allow concurrency race
        await new Promise((r) => setTimeout(r, 50));
        executionCount++;
        return { message: "Payment processed successfully", data: { paymentId, status: "success" } };
      };

      // Fire 3 concurrent requests simultaneously with identical key
      const [r1, r2, r3] = await Promise.all([
        idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          executeBusinessLogic
        ),
        idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          executeBusinessLogic
        ),
        idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          executeBusinessLogic
        )
      ]);

      assert.equal(executionCount, 1, "Exactly one business operation must execute");

      // Verify all 3 requests received the exact same successful response
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(r3.statusCode, 200);
      assert.deepEqual(r1.response.data, r2.response.data);
    });
  });

  describe("Test D: Same Key With Different Request Data (Fingerprint Mismatch)", () => {
    it("should reject with 409 Conflict when key is reused with a different paymentId or payload", async () => {
      const key = `idem-${Date.now()}-D`;
      const paymentId1 = generatePaymentID();
      const paymentId2 = generatePaymentID();

      // First request for paymentId1
      await idempotencyService.processWithIdempotency(
        { key, paymentId: paymentId1, endpoint: `/api/payments/${paymentId1}/process`, body: { result: "success" } },
        async () => ({ message: "Success", data: { paymentId: paymentId1 } })
      );

      // Second request reusing the same key for paymentId2 -> must throw 409 Conflict
      await assert.rejects(
        async () => {
          await idempotencyService.processWithIdempotency(
            { key, paymentId: paymentId2, endpoint: `/api/payments/${paymentId2}/process`, body: { result: "success" } },
            async () => ({ message: "Success", data: { paymentId: paymentId2 } })
          );
        },
        /Idempotency key conflict/
      );
    });
  });

  describe("Test E: Request Currently Processing", () => {
    it("should prevent duplicate processing if an active in-flight request does not complete in time", async () => {
      const key = `idem-${Date.now()}-E`;
      const paymentId = generatePaymentID();

      // Pre-seed an idempotency record stuck in PROCESSING
      await idempotencyKeyRepository.create({
        key,
        paymentId,
        requestFingerprint: "pre-seeded-fingerprint",
        status: IDEMPOTENCY_STATUS.PROCESSING,
        expiresAt: new Date(Date.now() + 60000)
      });

      // Attempting the same request while locked in PROCESSING must reject with 409 Conflict
      await assert.rejects(
        async () => {
          await idempotencyService.processWithIdempotency(
            { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
            async () => ({ message: "Should not run", data: {} })
          );
        },
        /409/
      );
    });
  });

  describe("Test F: Failed Request Retry", () => {
    it("should mark key FAILED on error and allow a subsequent retry to succeed", async () => {
      const key = `idem-${Date.now()}-F`;
      const paymentId = generatePaymentID();
      let attemptCount = 0;

      const failingLogic = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error("Temporary provider failure on attempt 1");
        }
        return { message: "Recovered on attempt 2", data: { paymentId, status: "success" } };
      };

      // Attempt 1: fails
      await assert.rejects(async () => {
        await idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          failingLogic
        );
      }, /Temporary provider failure on attempt 1/);

      const recordAfterFail = await idempotencyKeyRepository.findByKey(key);
      assert.equal(recordAfterFail.status, IDEMPOTENCY_STATUS.FAILED);

      // Attempt 2: retry with the same key succeeds
      const res2 = await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        failingLogic
      );

      assert.equal(res2.isCached, false);
      assert.equal(res2.statusCode, 200);

      const recordAfterSuccess = await idempotencyKeyRepository.findByKey(key);
      assert.equal(recordAfterSuccess.status, IDEMPOTENCY_STATUS.COMPLETED);
      assert.equal(attemptCount, 2);
    });
  });

  describe("Test G: TTL Expiration Configuration", () => {
    it("should set an expiresAt timestamp into the future for automatic TTL cleanup", async () => {
      const key = `idem-${Date.now()}-G`;
      const paymentId = generatePaymentID();

      await idempotencyService.processWithIdempotency(
        { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
        async () => ({ message: "Success", data: { paymentId } })
      );

      const record = await idempotencyKeyRepository.findByKey(key);
      assert.ok(record.expiresAt instanceof Date);
      assert.ok(record.expiresAt.getTime() > Date.now(), "expiresAt must be in the future");
    });
  });
});
