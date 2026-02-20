import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import type { AppConfig } from "./env";

export type DecodedTransactionInfo = {
  productId?: string;
  transactionId?: string;
  price?: number;
  currency?: string;
};

export type VerifiedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype: string | null;
  environment: string;
  bundleId: string;
  appAppleId: number;
  pushoverUserKey: string;
  pushoverDevice?: string;
  signedTransactionInfo?: string;
  transactionInfo?: DecodedTransactionInfo;
};

type VerifierPair = {
  production: SignedDataVerifier;
  sandbox: SignedDataVerifier;
};

const verifierCache = new Map<string, VerifierPair>();

function resolveRootCaDirectory(rootCaDir: string): string {
  if (isAbsolute(rootCaDir)) {
    return rootCaDir;
  }
  return join(process.cwd(), rootCaDir);
}

function loadAppleRootCAs(rootCaDir: string): Buffer[] {
  const absoluteDir = resolveRootCaDirectory(rootCaDir);

  if (!existsSync(absoluteDir)) {
    throw new Error(
      `Apple root CA directory not found: ${absoluteDir}. Add Apple root certificates to this folder.`
    );
  }

  const certFiles = readdirSync(absoluteDir).filter((file) =>
    /\.(cer|crt|pem|der)$/i.test(file)
  );

  if (certFiles.length === 0) {
    throw new Error(
      `No Apple root certificates found in ${absoluteDir}. Add .cer/.crt/.pem/.der files.`
    );
  }

  return certFiles.map((file) => readFileSync(join(absoluteDir, file)));
}

function getVerifierCacheKey(
  config: AppConfig,
  bundleId: string,
  appAppleId: number
): string {
  return JSON.stringify({
    bundleId,
    appId: appAppleId,
    onlineChecks: config.appleEnableOnlineChecks,
    rootCaDir: resolveRootCaDirectory(config.appleRootCaDir)
  });
}

function createVerifiers(
  config: AppConfig,
  bundleId: string,
  appAppleId: number
): VerifierPair {
  const rootCAs = loadAppleRootCAs(config.appleRootCaDir);

  return {
    production: new SignedDataVerifier(
      rootCAs,
      config.appleEnableOnlineChecks,
      Environment.PRODUCTION,
      bundleId,
      appAppleId
    ),
    sandbox: new SignedDataVerifier(
      rootCAs,
      config.appleEnableOnlineChecks,
      Environment.SANDBOX,
      bundleId
    )
  };
}

function getVerifiers(
  config: AppConfig,
  bundleId: string,
  appAppleId: number
): VerifierPair {
  const cacheKey = getVerifierCacheKey(config, bundleId, appAppleId);
  const cached = verifierCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const created = createVerifiers(config, bundleId, appAppleId);
  verifierCache.set(cacheKey, created);
  return created;
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Apple payload is missing required field '${field}'.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureNotificationPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Apple notification payload is not an object.");
  }

  return value as Record<string, unknown>;
}

function ensureBundleIdMatches(expectedBundleId: string | undefined, bundleId: string): void {
  if (expectedBundleId && bundleId !== expectedBundleId) {
    throw new Error(
      `Bundle ID mismatch. Expected '${expectedBundleId}' but got '${bundleId}'.`
    );
  }
}

function extractBundleIdFromSignedPayload(signedPayload: string): string | null {
  const parts = signedPayload.split(".");

  if (parts.length < 2) {
    return null;
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    const topLevelBundleId = optionalNonEmptyString(payload.bundleId);
    if (topLevelBundleId) {
      return topLevelBundleId;
    }

    if (payload.data && typeof payload.data === "object") {
      const nestedBundleId = optionalNonEmptyString(
        (payload.data as Record<string, unknown>).bundleId
      );
      if (nestedBundleId) {
        return nestedBundleId;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function decodeTransactionInfo(
  verifier: SignedDataVerifier,
  signedTransactionInfo: string | undefined
): Promise<DecodedTransactionInfo | undefined> {
  if (!signedTransactionInfo) {
    return undefined;
  }

  const decoded = (await verifier.verifyAndDecodeTransaction(
    signedTransactionInfo
  )) as Record<string, unknown>;

  const price =
    typeof decoded.price === "number"
      ? decoded.price
      : typeof decoded.price === "string"
        ? Number(decoded.price)
        : undefined;

  return {
    productId:
      typeof decoded.productId === "string" ? decoded.productId : undefined,
    transactionId:
      typeof decoded.transactionId === "string"
        ? decoded.transactionId
        : undefined,
    price: Number.isFinite(price) ? price : undefined,
    currency:
      typeof decoded.currency === "string" ? decoded.currency : undefined
  };
}

export async function verifyAppleNotification(
  signedPayload: string,
  config: AppConfig
): Promise<VerifiedNotification> {
  let lastError: unknown = null;

  for (const app of config.appleApps) {
    const bundleIdForVerifier =
      app.bundleId ?? extractBundleIdFromSignedPayload(signedPayload);

    if (!bundleIdForVerifier) {
      lastError = new Error(
        "Could not determine bundleId for verification. Set APPLE_BUNDLE_ID or provide bundleId in APPLE_APPS_JSON."
      );
      continue;
    }

    const verifiers = getVerifiers(config, bundleIdForVerifier, app.appAppleId);
    let decodedPayload: Record<string, unknown> | null = null;
    let usedVerifier: SignedDataVerifier | null = null;

    for (const verifier of [verifiers.production, verifiers.sandbox]) {
      try {
        const raw = await verifier.verifyAndDecodeNotification(signedPayload);
        decodedPayload = ensureNotificationPayload(raw);
        usedVerifier = verifier;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!decodedPayload || !usedVerifier) {
      continue;
    }

    const notificationUUID = ensureString(
      decodedPayload.notificationUUID,
      "notificationUUID"
    );
    const notificationType = ensureString(
      decodedPayload.notificationType,
      "notificationType"
    );
    const data =
      decodedPayload.data && typeof decodedPayload.data === "object"
        ? (decodedPayload.data as Record<string, unknown>)
        : undefined;

    const bundleId =
      optionalNonEmptyString(decodedPayload.bundleId) ??
      optionalNonEmptyString(data?.bundleId);

    if (!bundleId) {
      throw new Error(
        "Apple payload is missing required field 'bundleId' (expected at payload.bundleId or payload.data.bundleId)."
      );
    }

    ensureBundleIdMatches(app.bundleId, bundleId);

    const signedTransactionInfo =
      data && typeof data.signedTransactionInfo === "string"
        ? data.signedTransactionInfo
        : undefined;

    const transactionInfo = await decodeTransactionInfo(
      usedVerifier,
      signedTransactionInfo
    );

    return {
      notificationUUID,
      notificationType,
      subtype:
        typeof decodedPayload.subtype === "string" ? decodedPayload.subtype : null,
      environment:
        optionalNonEmptyString(decodedPayload.environment) ??
        optionalNonEmptyString(data?.environment) ??
        "UNKNOWN",
      bundleId,
      appAppleId: app.appAppleId,
      pushoverUserKey: app.pushoverUserKey,
      pushoverDevice: app.pushoverDevice,
      signedTransactionInfo,
      transactionInfo
    };
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to verify Apple signed payload.");
}
