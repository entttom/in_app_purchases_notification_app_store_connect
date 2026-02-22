import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/env";
import { createWebhookHandler, type WebhookRequest } from "../src/webhookHandler";

type MockResponse = {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, string>;
  status: (code: number) => MockResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 200,
    jsonBody: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    }
  };
}

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

async function invokeHandler(
  request: WebhookRequest,
  overrides: Parameters<typeof createWebhookHandler>[0] = {}
) {
  const response = createResponse();
  const handler = createWebhookHandler({
    loadConfig: () => createConfig(),
    verifyNotification: vi.fn().mockResolvedValue({
      notificationUUID: "uuid-1",
      notificationType: "SUBSCRIBED",
      subtype: null,
      environment: "Sandbox",
      bundleId: "com.example.app",
      appAppleId: 1234567890,
      pushoverUserKey: "pushover-user-key",
      pushoverDevice: undefined,
      transactionInfo: {
        productId: "pro_monthly",
        transactionId: "1000001234567890"
      }
    }),
    markNotificationAsNew: vi.fn().mockResolvedValue(true),
    sendPushover: vi.fn().mockResolvedValue(undefined),
    determineSubscriptionLifecycleHint: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...overrides
  });

  await handler(request, response);
  return response;
}

describe("createWebhookHandler", () => {
  it("sends one push for a valid purchase event", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      { sendPushover }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).toHaveBeenCalledTimes(1);
    expect(sendPushover).toHaveBeenCalledWith(
      expect.anything(),
      "In-App Kauf",
      expect.stringContaining("app=com.example.app"),
      { userKey: "pushover-user-key", device: undefined }
    );
  });

  it("works without APPLE_BUNDLE_ID in config", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        loadConfig: () => ({
          ...createConfig(),
          appleApps: [
            {
              appAppleId: 1234567890,
              pushoverUserKey: "pushover-user-key"
            }
          ]
        }),
        sendPushover
      }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).toHaveBeenCalledTimes(1);
  });

  it("sends one push for refund events", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        sendPushover,
        verifyNotification: vi.fn().mockResolvedValue({
          notificationUUID: "uuid-refund",
          notificationType: "REFUND",
          subtype: null,
          environment: "Production",
          bundleId: "com.example.app",
          appAppleId: 1234567890,
          pushoverUserKey: "pushover-user-key",
          pushoverDevice: undefined,
          transactionInfo: {
            productId: "pro_yearly",
            transactionId: "1000001111222233"
          }
        })
      }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).toHaveBeenCalledTimes(1);
  });

  it("includes lifecycle details for trial to paid renewals", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        sendPushover,
        determineSubscriptionLifecycleHint: vi
          .fn()
          .mockResolvedValue("FIRST_PAID_AFTER_TRIAL"),
        verifyNotification: vi.fn().mockResolvedValue({
          notificationUUID: "uuid-renew",
          notificationType: "DID_RENEW",
          subtype: "BILLING_RECOVERY",
          environment: "Production",
          bundleId: "com.example.app",
          appAppleId: 1234567890,
          pushoverUserKey: "pushover-user-key",
          pushoverDevice: undefined,
          transactionInfo: {
            productId: "pro_yearly",
            transactionId: "1000001111222233",
            transactionReason: "RENEWAL",
            offerDiscountType: "FREE_TRIAL"
          }
        })
      }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).toHaveBeenCalledTimes(1);
    expect(sendPushover).toHaveBeenCalledWith(
      expect.anything(),
      "In-App Kauf",
      expect.stringContaining("lifecycle=FIRST_PAID_AFTER_TRIAL"),
      { userKey: "pushover-user-key", device: undefined }
    );
  });

  it("ignores unrelated events", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        sendPushover,
        verifyNotification: vi.fn().mockResolvedValue({
          notificationUUID: "uuid-ignore",
          notificationType: "DID_CHANGE_RENEWAL_STATUS",
          subtype: null,
          environment: "Production",
          bundleId: "com.example.app",
          appAppleId: 1234567890,
          pushoverUserKey: "pushover-user-key",
          pushoverDevice: undefined
        })
      }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).not.toHaveBeenCalled();
    expect(response.jsonBody).toEqual({ ok: true, ignored: true });
  });

  it("deduplicates already processed notification UUIDs", async () => {
    const sendPushover = vi.fn().mockResolvedValue(undefined);
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        markNotificationAsNew: vi.fn().mockResolvedValue(false),
        sendPushover
      }
    );

    expect(response.statusCode).toBe(200);
    expect(sendPushover).not.toHaveBeenCalled();
    expect(response.jsonBody).toEqual({ ok: true, deduped: true });
  });

  it("returns 404 for wrong endpoint secret", async () => {
    const response = await invokeHandler({
      method: "POST",
      query: { secret: "wrong-secret" },
      body: { signedPayload: "jws-data" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.jsonBody).toEqual({ ok: false, error: "not_found" });
  });

  it("returns 400 when signedPayload is missing", async () => {
    const response = await invokeHandler({
      method: "POST",
      query: { secret: "super-secret" },
      body: { foo: "bar" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.jsonBody).toEqual({ ok: false, error: "invalid_payload" });
  });

  it("returns 400 when signature verification fails", async () => {
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "bad-jws" }
      },
      {
        verifyNotification: vi
          .fn()
          .mockRejectedValue(new Error("verification failed"))
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.jsonBody).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("returns 500 when dedupe storage fails", async () => {
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        markNotificationAsNew: vi.fn().mockRejectedValue(new Error("upstash down"))
      }
    );

    expect(response.statusCode).toBe(500);
    expect(response.jsonBody).toEqual({ ok: false, error: "internal_error" });
  });

  it("returns 500 when pushover send fails", async () => {
    const response = await invokeHandler(
      {
        method: "POST",
        query: { secret: "super-secret" },
        body: { signedPayload: "jws-data" }
      },
      {
        sendPushover: vi.fn().mockRejectedValue(new Error("pushover down"))
      }
    );

    expect(response.statusCode).toBe(500);
    expect(response.jsonBody).toEqual({ ok: false, error: "internal_error" });
  });
});
