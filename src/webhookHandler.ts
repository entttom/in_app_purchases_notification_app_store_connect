import { verifyAppleNotification, type VerifiedNotification } from "./appleVerifier";
import { markNotificationAsNew } from "./dedupeStore";
import { loadConfig, type AppConfig } from "./env";
import { classifyNotificationType } from "./eventClassifier";
import { buildPushoverMessage } from "./messageBuilder";
import { sendPushoverNotification, type PushoverTarget } from "./pushover";

type WebhookResult = { ok: boolean; [key: string]: unknown };

export type WebhookRequest = {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
};

export type WebhookResponse = {
  status: (code: number) => WebhookResponse;
  json: (body: WebhookResult) => void;
  setHeader?: (name: string, value: string) => void;
};

type LogPayload = {
  action: "ignored" | "deduped" | "pushed" | "error";
  notificationUUID?: string;
  notificationType?: string;
  environment?: string;
  error?: string;
};

type WebhookDependencies = {
  loadConfig: () => AppConfig;
  verifyNotification: (
    signedPayload: string,
    config: AppConfig
  ) => Promise<VerifiedNotification>;
  markNotificationAsNew: (
    notificationUUID: string,
    config: AppConfig
  ) => Promise<boolean>;
  sendPushover: (
    config: AppConfig,
    title: string,
    message: string,
    target?: PushoverTarget
  ) => Promise<void>;
  log: (payload: LogPayload) => void;
};

const defaultDependencies: WebhookDependencies = {
  loadConfig,
  verifyNotification: verifyAppleNotification,
  markNotificationAsNew,
  sendPushover: sendPushoverNotification,
  log: (payload) => {
    console.log(JSON.stringify(payload));
  }
};

function readQueryParam(query: Record<string, unknown> | undefined, key: string): string | null {
  const value = query?.[key];

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  return null;
}

function getSignedPayload(body: unknown): string | null {
  if (typeof body === "string") {
    try {
      return getSignedPayload(JSON.parse(body));
    } catch {
      return null;
    }
  }

  if (body && typeof body === "object") {
    const payload = (body as Record<string, unknown>).signedPayload;
    if (typeof payload === "string" && payload.trim().length > 0) {
      return payload;
    }
  }

  return null;
}

function responseJson(
  response: WebhookResponse,
  statusCode: number,
  body: WebhookResult
): void {
  response.status(statusCode).json(body);
}

function buildLogPayload(
  action: LogPayload["action"],
  verified: VerifiedNotification,
  error?: unknown
): LogPayload {
  return {
    action,
    notificationUUID: verified.notificationUUID,
    notificationType: verified.notificationType,
    environment: verified.environment,
    error: error instanceof Error ? error.message : undefined
  };
}

export function createWebhookHandler(
  overrides: Partial<WebhookDependencies> = {}
): (request: WebhookRequest, response: WebhookResponse) => Promise<void> {
  const deps: WebhookDependencies = {
    ...defaultDependencies,
    ...overrides
  };

  return async function webhookHandler(
    request: WebhookRequest,
    response: WebhookResponse
  ): Promise<void> {
    response.setHeader?.("Cache-Control", "no-store");

    if (request.method !== "POST") {
      responseJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    let config: AppConfig;
    try {
      config = deps.loadConfig();
    } catch (error) {
      deps.log({ action: "error", error: error instanceof Error ? error.message : String(error) });
      responseJson(response, 500, { ok: false, error: "invalid_configuration" });
      return;
    }

    const secretFromPath = readQueryParam(request.query, "secret");
    if (secretFromPath !== config.webhookSecret) {
      responseJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    const signedPayload = getSignedPayload(request.body);
    if (!signedPayload) {
      responseJson(response, 400, { ok: false, error: "invalid_payload" });
      return;
    }

    let verified: VerifiedNotification;
    try {
      verified = await deps.verifyNotification(signedPayload, config);
    } catch (error) {
      deps.log({
        action: "error",
        error: error instanceof Error ? error.message : String(error)
      });
      responseJson(response, 400, { ok: false, error: "invalid_signature" });
      return;
    }

    const eventAction = classifyNotificationType(verified.notificationType);
    if (eventAction === "IGNORE") {
      deps.log(buildLogPayload("ignored", verified));
      responseJson(response, 200, { ok: true, ignored: true });
      return;
    }

    try {
      const isNew = await deps.markNotificationAsNew(
        verified.notificationUUID,
        config
      );

      if (!isNew) {
        deps.log(buildLogPayload("deduped", verified));
        responseJson(response, 200, { ok: true, deduped: true });
        return;
      }

      const message = buildPushoverMessage({
        action: eventAction,
        appBundleId: verified.bundleId,
        notificationType: verified.notificationType,
        environment: verified.environment,
        productId: verified.transactionInfo?.productId,
        transactionId: verified.transactionInfo?.transactionId,
        price: verified.transactionInfo?.price,
        currency: verified.transactionInfo?.currency
      });

      await deps.sendPushover(config, message.title, message.message, {
        userKey: verified.pushoverUserKey,
        device: verified.pushoverDevice
      });
      deps.log(buildLogPayload("pushed", verified));
      responseJson(response, 200, { ok: true });
    } catch (error) {
      deps.log(buildLogPayload("error", verified, error));
      responseJson(response, 500, { ok: false, error: "internal_error" });
    }
  };
}
