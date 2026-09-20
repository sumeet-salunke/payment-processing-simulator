import idempotencyKeyRepository from "../repositories/idempotencyKey.repository.js";
import ApiError from "../utils/ApiError.js";
import { IDEMPOTENCY_STATUS, IDEMPOTENCY_EXPIRY_MS } from "../constants/idempotency.constants.js";
import { generateRequestFingerprint } from "../helpers/requestFingerprint.js";

class IdempotencyService {
  async processWithIdempotency({ key, paymentId, endpoint = "/api/payments/process", body = {} }, executeFn) {
    if (!key) {
      // If no idempotency key provided, proceed with direct execution
      const result = await executeFn();
      return {
        isCached: false,
        statusCode: 200,
        response: {
          success: true,
          statusCode: 200,
          message: result.message || "Payment processed successfully",
          data: result.data || result
        }
      };
    }

    const currentFingerprint = generateRequestFingerprint({ paymentId, endpoint, body });

    // 1. Check existing record in DB
    let existingRecord = await idempotencyKeyRepository.findByKey(key);

    if (existingRecord) {
      // Invariant: An idempotency key cannot be reused for a different request payload or paymentId
      if (existingRecord.requestFingerprint !== currentFingerprint) {
        throw new ApiError(
          409,
          `Idempotency key conflict: key '${key}' was already used with a different request payload or target`
        );
      }

      // If already completed, replay stored response without executing business logic again
      if (existingRecord.status === IDEMPOTENCY_STATUS.COMPLETED) {
        return {
          isCached: true,
          statusCode: existingRecord.statusCode || 200,
          response: existingRecord.response
        };
      }

      // If currently processing, wait briefly in case concurrent request completes
      if (existingRecord.status === IDEMPOTENCY_STATUS.PROCESSING) {
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          existingRecord = await idempotencyKeyRepository.findByKey(key);
          if (existingRecord?.status === IDEMPOTENCY_STATUS.COMPLETED) {
            return {
              isCached: true,
              statusCode: existingRecord.statusCode || 200,
              response: existingRecord.response
            };
          }
        }
        throw new ApiError(
          409,
          "A request with this idempotency key is currently being processed"
        );
      }

      // If previously failed, re-claim the key: FAILED -> PROCESSING
      const reclaimed = await idempotencyKeyRepository.updateStatus(
        key,
        IDEMPOTENCY_STATUS.FAILED,
        IDEMPOTENCY_STATUS.PROCESSING
      );

      if (!reclaimed) {
        const current = await idempotencyKeyRepository.findByKey(key);
        if (current?.status === IDEMPOTENCY_STATUS.COMPLETED) {
          return {
            isCached: true,
            statusCode: current.statusCode || 200,
            response: current.response
          };
        }
        throw new ApiError(
          409,
          "A request with this idempotency key is currently being processed"
        );
      }
    } else {
      // 2. New request: claim ownership by creating record in PROCESSING state
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_EXPIRY_MS);

      try {
        await idempotencyKeyRepository.create({
          key,
          paymentId,
          requestFingerprint: currentFingerprint,
          status: IDEMPOTENCY_STATUS.PROCESSING,
          expiresAt
        });
      } catch (err) {
        // Handle MongoDB unique key violation (code 11000) from concurrent request race
        if (err.code === 11000 || err.name === "MongoServerError") {
          for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const concurrentRecord = await idempotencyKeyRepository.findByKey(key);
            if (concurrentRecord?.status === IDEMPOTENCY_STATUS.COMPLETED) {
              return {
                isCached: true,
                statusCode: concurrentRecord.statusCode || 200,
                response: concurrentRecord.response
              };
            }
          }
          throw new ApiError(
            409,
            "A request with this idempotency key is currently being processed"
          );
        }
        throw err;
      }
    }

    // 3. Execute the payment operation
    try {
      const result = await executeFn();
      const responsePayload = {
        success: true,
        statusCode: 200,
        message: result.message || "Payment processed successfully",
        data: result.data || result
      };

      await idempotencyKeyRepository.markCompleted(key, {
        statusCode: 200,
        response: responsePayload
      });

      return {
        isCached: false,
        statusCode: 200,
        response: responsePayload
      };
    } catch (error) {
      // Mark as FAILED so subsequent retries are allowed according to policy
      await idempotencyKeyRepository.markFailed(key, error.message);
      throw error;
    }
  }
}

export default new IdempotencyService();
