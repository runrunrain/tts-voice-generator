/**
 * Concurrency Control Service
 *
 * MVP: Rejection-based concurrency control (no queue).
 * When active jobs exceed maxConcurrentJobs, new requests are rejected
 * with a structured error containing retryable/requestId fields.
 *
 * Tracks in-flight generation jobs via a simple counter.
 * Not persisted across server restarts (acceptable for MVP).
 */

import { v4 as uuidv4 } from "uuid";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConcurrencyCheckResult {
  allowed: true;
  slotId: string;
}

export interface ConcurrencyDenyResult {
  allowed: false;
  error: {
    code: "CONCURRENCY_LIMIT";
    message: string;
    category: "throttle";
    retryable: true;
    metadata: {
      activeJobs: number;
      maxConcurrentJobs: number;
    };
  };
  requestId: string;
}

export type ConcurrencyResult = ConcurrencyCheckResult | ConcurrencyDenyResult;

// ─── In-flight tracker ────────────────────────────────────────────────────────

const activeSlots = new Map<string, { startedAt: number }>();

/**
 * Get the current number of active (in-flight) generation jobs.
 */
export function getActiveJobCount(): number {
  return activeSlots.size;
}

/**
 * Try to acquire a concurrency slot.
 *
 * @param maxConcurrentJobs - Maximum concurrent jobs allowed (from settings)
 * @returns ConcurrencyResult - either allowed with a slotId, or denied with error details
 */
export function acquireSlot(maxConcurrentJobs: number): ConcurrencyResult {
  const activeCount = activeSlots.size;

  if (activeCount >= maxConcurrentJobs) {
    return {
      allowed: false,
      error: {
        code: "CONCURRENCY_LIMIT",
        message: `Too many concurrent generation jobs. Active: ${activeCount}, limit: ${maxConcurrentJobs}. Please try again shortly.`,
        category: "throttle",
        retryable: true,
        metadata: {
          activeJobs: activeCount,
          maxConcurrentJobs,
        },
      },
      requestId: uuidv4(),
    };
  }

  const slotId = uuidv4();
  activeSlots.set(slotId, { startedAt: Date.now() });

  return { allowed: true, slotId };
}

/**
 * Release a previously acquired concurrency slot.
 * Safe to call multiple times (idempotent).
 *
 * @param slotId - The slot ID returned by acquireSlot
 */
export function releaseSlot(slotId: string): void {
  activeSlots.delete(slotId);
}

/**
 * Scan for stale slots that have been held longer than the given timeout.
 * Returns the number of slots cleaned up.
 *
 * This is a safety net against leaked slots (e.g., if releaseSlot
 * is not called due to an unhandled edge case).
 *
 * @param timeoutMs - Maximum allowed hold time in milliseconds (default: 5 minutes)
 * @returns Number of stale slots cleaned up
 */
export function cleanupStaleSlots(timeoutMs: number = 5 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [slotId, { startedAt }] of activeSlots.entries()) {
    if (now - startedAt >= timeoutMs) {
      activeSlots.delete(slotId);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Get info about active slots for diagnostic purposes.
 * Returns an array of slot ages in milliseconds.
 */
export function getActiveSlotAges(): number[] {
  const now = Date.now();
  return Array.from(activeSlots.values()).map(({ startedAt }) => now - startedAt);
}

/**
 * Reset all active slots. For testing only.
 */
export function resetAllSlots(): void {
  activeSlots.clear();
}
