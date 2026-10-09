/**
 * Boundary to the external payment network (EFT, Interac, etc.).
 *
 * The rail distinguishes two failure classes because the workflow must treat
 * them differently:
 *  - PayoutRejectedError: the rail definitively said no (closed account,
 *    compliance hold). Retrying is pointless; compensate.
 *  - Any other error: transient (timeout, 503). Retry with backoff.
 */
export interface PayoutRequest {
  loanId: string;
  amountCents: bigint;
  /** The rail must deduplicate on this, so a retried request never pays twice. */
  idempotencyKey: string;
}

export interface PaymentRail {
  send(request: PayoutRequest): Promise<{ providerRef: string }>;
}

export class PayoutRejectedError extends Error {
  override readonly name = 'PayoutRejectedError';
}

type Outcome = 'ok' | 'transient' | 'rejected';

/**
 * In-memory rail for local runs and tests. Scripted outcomes let tests drive
 * exact failure sequences; it also honours idempotency keys like a real rail.
 */
export class FakeRail implements PaymentRail {
  readonly calls: PayoutRequest[] = [];
  private readonly settled = new Map<string, string>();

  constructor(private readonly script: Outcome[] = []) {}

  async send(request: PayoutRequest): Promise<{ providerRef: string }> {
    this.calls.push(request);
    const previous = this.settled.get(request.idempotencyKey);
    if (previous) return { providerRef: previous };

    const outcome = this.script.shift() ?? 'ok';
    if (outcome === 'transient') throw new Error('payment rail timed out');
    if (outcome === 'rejected') throw new PayoutRejectedError('beneficiary account closed');

    const providerRef = `fake_${this.settled.size + 1}`;
    this.settled.set(request.idempotencyKey, providerRef);
    return { providerRef };
  }
}
