import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/env";

const { kvStore } = vi.hoisted(() => ({
  kvStore: new Map<string, string>()
}));

vi.mock("@upstash/redis", () => {
  class Redis {
    constructor(_: unknown) {}

    async get(key: string): Promise<string | null> {
      return kvStore.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<"OK"> {
      kvStore.set(key, value);
      return "OK";
    }
  }

  return { Redis };
});

import { determineSubscriptionLifecycleHint } from "../src/subscriptionStateStore";

function createConfig(): AppConfig {
  return {
    webhookSecret: "super-secret",
    pushoverAppToken: "pushover-app-token",
    defaultPushoverUserKey: "pushover-user-key",
    defaultPushoverDevice: undefined,
    appleApps: [
      {
        bundleId: "com.example.app",
        appAppleId: 1234567890,
        pushoverUserKey: "pushover-user-key",
        pushoverDevice: undefined
      }
    ],
    appleEnableOnlineChecks: false,
    appleRootCaDir: "certs/apple",
    kvRestApiUrl: "https://example.upstash.io",
    kvRestApiToken: "upstash-token",
    dedupeTtlSeconds: 2592000
  };
}

describe("determineSubscriptionLifecycleHint", () => {
  beforeEach(() => {
    kvStore.clear();
  });

  it("returns TRIAL_START for free trial subscribe events", async () => {
    const hint = await determineSubscriptionLifecycleHint(
      "SUBSCRIBED",
      {
        originalTransactionId: "otx-1",
        offerDiscountType: "FREE_TRIAL",
        originalPurchaseDate: 1700000000000,
        purchaseDate: 1700000000000
      },
      createConfig()
    );

    expect(hint).toBe("TRIAL_START");
  });

  it("returns FIRST_PAID_AFTER_TRIAL on first renew after a trial", async () => {
    const config = createConfig();
    const originalPurchaseDate = 1700000000000;

    await determineSubscriptionLifecycleHint(
      "SUBSCRIBED",
      {
        originalTransactionId: "otx-2",
        offerDiscountType: "FREE_TRIAL",
        originalPurchaseDate,
        purchaseDate: originalPurchaseDate
      },
      config
    );

    const hint = await determineSubscriptionLifecycleHint(
      "DID_RENEW",
      {
        originalTransactionId: "otx-2",
        originalPurchaseDate,
        purchaseDate: originalPurchaseDate + 7 * 24 * 60 * 60 * 1000
      },
      config
    );

    expect(hint).toBe("FIRST_PAID_AFTER_TRIAL");
  });

  it("returns RENEWAL when there is no trial signal", async () => {
    const hint = await determineSubscriptionLifecycleHint(
      "DID_RENEW",
      {
        originalTransactionId: "otx-3",
        originalPurchaseDate: 1700000000000,
        purchaseDate: 1700000000000 + 365 * 24 * 60 * 60 * 1000
      },
      createConfig()
    );

    expect(hint).toBe("RENEWAL");
  });
});
