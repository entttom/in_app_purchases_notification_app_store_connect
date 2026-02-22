import { Redis } from "@upstash/redis";
import type { DecodedTransactionInfo } from "./appleVerifier";
import type { AppConfig } from "./env";

const SUBSCRIPTION_STATE_TTL_SECONDS = 60 * 60 * 24 * 730;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

type SubscriptionState = {
  sawFreeTrial: boolean;
  didRenewCount: number;
  notificationCount: number;
  firstSeenAt: number;
  updatedAt: number;
  firstNotificationType: string;
  lastNotificationType: string;
  originalPurchaseDate?: number;
  firstPurchaseDate?: number;
  lastPurchaseDate?: number;
};

export type SubscriptionLifecycleHint =
  | "TRIAL_START"
  | "FIRST_PAID_AFTER_TRIAL"
  | "RENEWAL";

let redisClient: Redis | null = null;
let redisClientKey: string | null = null;

function getRedisClient(config: AppConfig): Redis {
  const key = `${config.kvRestApiUrl}::${config.kvRestApiToken}`;

  if (redisClient && redisClientKey === key) {
    return redisClient;
  }

  redisClient = new Redis({
    url: config.kvRestApiUrl,
    token: config.kvRestApiToken
  });
  redisClientKey = key;
  return redisClient;
}

function getSubscriptionStateKey(originalTransactionId: string): string {
  return `appstore:subscription:${originalTransactionId}`;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseSubscriptionState(raw: unknown): SubscriptionState | null {
  if (raw === null || typeof raw === "undefined") {
    return null;
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const value = parsed as Record<string, unknown>;
  const firstSeenAt = optionalFiniteNumber(value.firstSeenAt);
  const updatedAt = optionalFiniteNumber(value.updatedAt);
  const didRenewCount = optionalFiniteNumber(value.didRenewCount);
  const notificationCount = optionalFiniteNumber(value.notificationCount);
  const firstNotificationType =
    typeof value.firstNotificationType === "string"
      ? value.firstNotificationType
      : undefined;
  const lastNotificationType =
    typeof value.lastNotificationType === "string"
      ? value.lastNotificationType
      : undefined;

  if (
    typeof value.sawFreeTrial !== "boolean" ||
    firstSeenAt === undefined ||
    updatedAt === undefined ||
    didRenewCount === undefined ||
    notificationCount === undefined ||
    !firstNotificationType ||
    !lastNotificationType
  ) {
    return null;
  }

  return {
    sawFreeTrial: value.sawFreeTrial,
    didRenewCount,
    notificationCount,
    firstSeenAt,
    updatedAt,
    firstNotificationType,
    lastNotificationType,
    originalPurchaseDate: optionalFiniteNumber(value.originalPurchaseDate),
    firstPurchaseDate: optionalFiniteNumber(value.firstPurchaseDate),
    lastPurchaseDate: optionalFiniteNumber(value.lastPurchaseDate)
  };
}

function hasFreeTrial(transactionInfo: DecodedTransactionInfo | undefined): boolean {
  return transactionInfo?.offerDiscountType === "FREE_TRIAL";
}

function isLikelyFirstPaidAfterTrialByDates(
  transactionInfo: DecodedTransactionInfo | undefined
): boolean {
  const purchaseDate = transactionInfo?.purchaseDate;
  const originalPurchaseDate = transactionInfo?.originalPurchaseDate;

  if (
    typeof purchaseDate !== "number" ||
    !Number.isFinite(purchaseDate) ||
    typeof originalPurchaseDate !== "number" ||
    !Number.isFinite(originalPurchaseDate)
  ) {
    return false;
  }

  const deltaMs = purchaseDate - originalPurchaseDate;
  if (deltaMs <= 0) {
    return false;
  }

  const deltaDays = deltaMs / ONE_DAY_IN_MS;
  return deltaDays >= 5 && deltaDays <= 14;
}

function determineLifecycleHint(
  notificationType: string,
  transactionInfo: DecodedTransactionInfo | undefined,
  previousState: SubscriptionState | null
): SubscriptionLifecycleHint | undefined {
  if (notificationType === "SUBSCRIBED" && hasFreeTrial(transactionInfo)) {
    return "TRIAL_START";
  }

  if (notificationType !== "DID_RENEW") {
    return undefined;
  }

  const didRenewCount = previousState?.didRenewCount ?? 0;
  const previousEventWasTrial =
    previousState?.sawFreeTrial === true && didRenewCount === 0;

  if (previousEventWasTrial || isLikelyFirstPaidAfterTrialByDates(transactionInfo)) {
    return "FIRST_PAID_AFTER_TRIAL";
  }

  return "RENEWAL";
}

export async function determineSubscriptionLifecycleHint(
  notificationType: string,
  transactionInfo: DecodedTransactionInfo | undefined,
  config: AppConfig
): Promise<SubscriptionLifecycleHint | undefined> {
  const originalTransactionId = transactionInfo?.originalTransactionId;
  if (!originalTransactionId) {
    return undefined;
  }

  const redis = getRedisClient(config);
  const stateKey = getSubscriptionStateKey(originalTransactionId);

  const existingRaw = await redis.get(stateKey);
  const previousState = parseSubscriptionState(existingRaw);
  const lifecycleHint = determineLifecycleHint(
    notificationType,
    transactionInfo,
    previousState
  );

  const now = Date.now();
  const purchaseDate = transactionInfo?.purchaseDate;
  const nextState: SubscriptionState = {
    sawFreeTrial:
      previousState?.sawFreeTrial === true ||
      hasFreeTrial(transactionInfo) ||
      lifecycleHint === "FIRST_PAID_AFTER_TRIAL",
    didRenewCount:
      (previousState?.didRenewCount ?? 0) + (notificationType === "DID_RENEW" ? 1 : 0),
    notificationCount: (previousState?.notificationCount ?? 0) + 1,
    firstSeenAt: previousState?.firstSeenAt ?? now,
    updatedAt: now,
    firstNotificationType: previousState?.firstNotificationType ?? notificationType,
    lastNotificationType: notificationType,
    originalPurchaseDate:
      transactionInfo?.originalPurchaseDate ?? previousState?.originalPurchaseDate,
    firstPurchaseDate:
      previousState?.firstPurchaseDate ??
      (typeof purchaseDate === "number" && Number.isFinite(purchaseDate)
        ? purchaseDate
        : undefined),
    lastPurchaseDate:
      typeof purchaseDate === "number" && Number.isFinite(purchaseDate)
        ? purchaseDate
        : previousState?.lastPurchaseDate
  };

  await redis.set(stateKey, JSON.stringify(nextState), {
    ex: SUBSCRIPTION_STATE_TTL_SECONDS
  });

  return lifecycleHint;
}
