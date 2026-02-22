import { describe, expect, it } from "vitest";
import { buildPushoverMessage } from "../src/messageBuilder";

describe("buildPushoverMessage", () => {
  it("formats Apple milliunit price values into major currency units", () => {
    const message = buildPushoverMessage({
      action: "PURCHASE",
      appBundleId: "com.example.app",
      notificationType: "DID_RENEW",
      environment: "Production",
      productId: "com.example.yearly",
      transactionId: "1000001234567890",
      price: 29990,
      currency: "EUR"
    });

    expect(message.message).toContain("amount=29.99 EUR");
  });

  it("does not include amount when price is missing", () => {
    const message = buildPushoverMessage({
      action: "PURCHASE",
      appBundleId: "com.example.app",
      notificationType: "DID_RENEW",
      environment: "Production",
      productId: "com.example.yearly",
      transactionId: "1000001234567890"
    });

    expect(message.message).not.toContain("amount=");
  });

  it("includes subscription diagnostics when available", () => {
    const message = buildPushoverMessage({
      action: "PURCHASE",
      appBundleId: "com.example.app",
      notificationType: "DID_RENEW",
      subtype: "BILLING_RECOVERY",
      environment: "Production",
      productId: "com.example.yearly",
      transactionId: "1000001234567890",
      transactionReason: "RENEWAL",
      offerDiscountType: "FREE_TRIAL",
      subscriptionLifecycle: "FIRST_PAID_AFTER_TRIAL"
    });

    expect(message.message).toContain("subtype=BILLING_RECOVERY");
    expect(message.message).toContain("reason=RENEWAL");
    expect(message.message).toContain("offer=FREE_TRIAL");
    expect(message.message).toContain("lifecycle=FIRST_PAID_AFTER_TRIAL");
  });
});
