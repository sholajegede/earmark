/** True when Convex gave up on a transaction because other transactions kept changing the same rows. */
export const isConflict = (error: unknown): boolean => error instanceof Error && /changed while this mutation was being run/i.test(error.message);

/**
 * Try again when a transaction conflicts, with a random, growing wait so the retries do not collide again.
 * Only use this for a call that is safe to repeat. Admission is, because it is keyed. So is settling, because a job settles once.
 */
export async function retryConflicts<T>(call: () => Promise<T>, tries = 8, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isConflict(error) || attempt >= tries) throw error;
      await wait(Math.min(1_000, 40 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
}
