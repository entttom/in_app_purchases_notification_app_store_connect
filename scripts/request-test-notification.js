#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  AppStoreServerAPIClient,
  Environment
} = require("@apple/app-store-server-library");

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function getEnvironmentValue(rawValue) {
  const normalized = (rawValue || "SANDBOX").trim().toUpperCase();

  if (normalized === "PRODUCTION") {
    return Environment.PRODUCTION;
  }

  if (normalized === "XCODE") {
    return Environment.XCODE;
  }

  if (normalized === "LOCAL_TESTING") {
    return Environment.LOCAL_TESTING;
  }

  return Environment.SANDBOX;
}

function parsePositiveInt(rawValue, fallbackValue) {
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function formatAttemptDate(epochMs) {
  if (!Number.isFinite(epochMs)) {
    return "n/a";
  }
  return new Date(epochMs).toISOString();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatusNotReadyError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return error.apiError === 4040008;
}

async function main() {
  loadDotEnvFile(path.resolve(process.cwd(), ".env.local"));
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));

  const issuerId = readEnv("APP_STORE_ISSUER_ID", "ASC_ISSUER_ID");
  const keyId = readEnv("APP_STORE_KEY_ID", "ASC_KEY_ID");
  const bundleId = readEnv("APP_STORE_BUNDLE_ID", "APPLE_BUNDLE_ID");
  const keyPath = readEnv("APP_STORE_PRIVATE_KEY_PATH", "ASC_PRIVATE_KEY_PATH");
  const rawPrivateKey = readEnv("APP_STORE_PRIVATE_KEY", "ASC_PRIVATE_KEY");
  const environment = getEnvironmentValue(readEnv("APP_STORE_ENVIRONMENT"));
  const pollAttempts = parsePositiveInt(readEnv("APP_STORE_TEST_POLL_ATTEMPTS"), 8);
  const pollIntervalMs = parsePositiveInt(
    readEnv("APP_STORE_TEST_POLL_INTERVAL_MS"),
    3000
  );

  const missing = [];
  if (!issuerId) {
    missing.push("APP_STORE_ISSUER_ID");
  }
  if (!keyId) {
    missing.push("APP_STORE_KEY_ID");
  }
  if (!bundleId) {
    missing.push("APP_STORE_BUNDLE_ID (or APPLE_BUNDLE_ID)");
  }
  if (!keyPath && !rawPrivateKey) {
    missing.push("APP_STORE_PRIVATE_KEY_PATH or APP_STORE_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    console.error("Missing required environment variables:");
    for (const item of missing) {
      console.error(`- ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  const signingKey = keyPath
    ? fs.readFileSync(path.resolve(process.cwd(), keyPath), "utf8")
    : rawPrivateKey.replace(/\\n/g, "\n");

  const client = new AppStoreServerAPIClient(
    signingKey,
    keyId,
    issuerId,
    bundleId,
    environment
  );

  console.log(`Environment: ${environment}`);
  console.log(`Bundle ID: ${bundleId}`);
  console.log("Requesting test notification...");

  const requestResponse = await client.requestTestNotification();
  const token = requestResponse.testNotificationToken;

  if (!token) {
    throw new Error("No testNotificationToken returned by Apple.");
  }

  console.log(`testNotificationToken: ${token}`);

  let latestStatus = null;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(pollIntervalMs);
    }

    try {
      latestStatus = await client.getTestNotificationStatus(token);
    } catch (error) {
      if (isStatusNotReadyError(error)) {
        console.log(
          `[poll ${attempt}/${pollAttempts}] sendAttempts=0 latestResult=PENDING at=n/a`
        );
        continue;
      }
      throw error;
    }

    const sendAttempts = Array.isArray(latestStatus.sendAttempts)
      ? latestStatus.sendAttempts
      : [];
    const latestAttempt = sendAttempts[sendAttempts.length - 1];
    const result = latestAttempt?.sendAttemptResult || "PENDING";
    const attemptDate = formatAttemptDate(latestAttempt?.attemptDate);

    console.log(
      `[poll ${attempt}/${pollAttempts}] sendAttempts=${sendAttempts.length} latestResult=${result} at=${attemptDate}`
    );

    if (result === "SUCCESS") {
      break;
    }
  }

  console.log("Final status:");
  console.log(JSON.stringify(latestStatus, null, 2));
}

main().catch((error) => {
  const message =
    error && typeof error === "object" && "message" in error
      ? error.message
      : String(error);

  console.error("Failed to request test notification.");
  console.error(message);

  const maybeApiError = error && typeof error === "object" ? error.apiError : null;
  if (maybeApiError) {
    console.error(JSON.stringify(maybeApiError, null, 2));
  }

  process.exitCode = 1;
});
