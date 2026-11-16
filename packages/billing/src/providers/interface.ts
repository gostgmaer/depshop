/**
 * Payment provider abstraction. DealMind never talks to Razorpay directly:
 * the production provider is the shared EasyDev payment service (which holds
 * the Razorpay credentials, verifies signatures and runs renewals). A
 * sandbox provider exists for tests and local development only; it moves no
 * money and is refused in production.
 */
import type { BillingIntervalValue, SubscriptionStatusValue } from "@dealmind/shared";

/** Who the customer is at the provider: the EasyDev (IAM) user id, shared by all EasyDev apps. */
export interface CustomerRef {
  customerId: string;
  email: string;
}

export interface ProviderPlanSpec {
  key: string; // e.g. "PRO:MONTHLY"
  name: string;
  description: string;
  amountPaise: number;
  interval: BillingIntervalValue;
}

export interface CheckoutStart {
  /** Provider-side transaction (payment) id. */
  transactionId: string;
  attemptId: string;
  /** Razorpay subscription id (what Checkout opens) or a sandbox order id. */
  orderId: string;
  /** Razorpay public key id for Checkout (null for the sandbox). */
  keyId: string | null;
  kind: "RAZORPAY" | "SANDBOX";
}

export type CheckoutProof =
  | { kind: "razorpay"; paymentId: string; subscriptionId: string; signature: string }
  | { kind: "sandbox"; outcome: "success" | "failure" };

export interface ProviderSubscription {
  id: string;
  /** The provider's plan id (mapped back to a DealMind plan + interval). */
  planId: string;
  status: SubscriptionStatusValue;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface ProviderPayment {
  id: string;
  amountPaise: number;
  currency: string;
  status: string;
  method: string | null;
  planId: string | null;
  invoiceId: string | null;
  createdAt: Date;
}

export interface ProviderInvoice {
  id: string;
  invoiceNumber: string | null;
  amountPaise: number;
  taxPaise: number;
  totalPaise: number;
  currency: string;
  status: string;
  issuedAt: Date | null;
  /** Free-form metadata (used to attribute an invoice to DealMind). */
  metadata: Record<string, unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status from the provider, if any. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface BillingProvider {
  /** Stored on subscriptions and checkouts ("easydev-payments" | "sandbox"). */
  readonly name: string;
  /** Creates (or finds) the provider plan for each spec; returns provider plan ids by key. */
  ensurePlans(specs: ProviderPlanSpec[]): Promise<Record<string, string>>;
  startCheckout(input: {
    customer: CustomerRef;
    providerPlanId: string;
    amountPaise: number;
    checkoutId: string;
    planCode: string;
    interval: BillingIntervalValue;
  }): Promise<CheckoutStart>;
  /** Server-side verification of the payment (signature checked by the provider). */
  confirmCheckout(input: {
    customer: CustomerRef;
    transactionId: string;
    attemptId: string;
    proof: CheckoutProof;
  }): Promise<{ verified: boolean; reason: string | null }>;
  /** The customer's subscriptions for DealMind, newest first. */
  listSubscriptions(customer: CustomerRef): Promise<ProviderSubscription[]>;
  cancel(customer: CustomerRef, subscriptionId: string, reason: string): Promise<void>;
  changePlan(customer: CustomerRef, subscriptionId: string, providerPlanId: string): Promise<void>;
  listPayments(customer: CustomerRef): Promise<ProviderPayment[]>;
  listInvoices(customer: CustomerRef): Promise<ProviderInvoice[]>;
}
