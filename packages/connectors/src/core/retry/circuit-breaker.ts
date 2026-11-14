/**
 * Per-source circuit breaker.
 *   CLOSED ──(N consecutive failures)──▶ OPEN ──(openMs elapsed)──▶ HALF_OPEN
 *   HALF_OPEN: one probe call; success → CLOSED, failure → OPEN again.
 * While OPEN, calls are rejected immediately (CIRCUIT_OPEN) so a failing
 * marketplace isn't hammered and searches don't wait on it.
 *
 * State is per process (each worker learns independently); transitions are
 * reported through `onTransition` so they can be persisted as source health.
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitSettings {
  failureThreshold: number;
  openMs: number;
}

interface Circuit {
  state: CircuitState;
  failures: number;
  openedAt: number;
  probing: boolean;
}

export class CircuitBreakers {
  private readonly circuits = new Map<string, Circuit>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onTransition: (
      sourceId: string,
      from: CircuitState,
      to: CircuitState,
    ) => void = () => undefined,
  ) {}

  private circuit(id: string): Circuit {
    let c = this.circuits.get(id);
    if (!c) {
      c = { state: "CLOSED", failures: 0, openedAt: 0, probing: false };
      this.circuits.set(id, c);
    }
    return c;
  }

  private move(id: string, c: Circuit, to: CircuitState): void {
    if (c.state === to) return;
    const from = c.state;
    c.state = to;
    this.onTransition(id, from, to);
  }

  state(id: string, settings: CircuitSettings): CircuitState {
    const c = this.circuit(id);
    if (c.state === "OPEN" && this.now() - c.openedAt >= settings.openMs)
      this.move(id, c, "HALF_OPEN");
    return c.state;
  }

  /** True when a call may proceed (claims the single half-open probe). */
  tryAcquire(id: string, settings: CircuitSettings): boolean {
    const state = this.state(id, settings);
    const c = this.circuit(id);
    if (state === "CLOSED") return true;
    if (state === "HALF_OPEN" && !c.probing) {
      c.probing = true;
      return true;
    }
    return false;
  }

  recordSuccess(id: string): void {
    const c = this.circuit(id);
    c.failures = 0;
    c.probing = false;
    this.move(id, c, "CLOSED");
  }

  recordFailure(id: string, settings: CircuitSettings): void {
    const c = this.circuit(id);
    c.probing = false;
    c.failures += 1;
    if (c.state === "HALF_OPEN" || c.failures >= settings.failureThreshold) {
      c.openedAt = this.now();
      this.move(id, c, "OPEN");
    }
  }

  /** Releases a probe that ended without a verdict (e.g. rate limited before calling). */
  release(id: string): void {
    this.circuit(id).probing = false;
  }
}
