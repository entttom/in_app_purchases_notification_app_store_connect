import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(1).optional()
);

const numericStringSchema = z.string().regex(/^\d+$/).transform((value) => Number(value));

const appleAppEntrySchema = z.object({
  bundleId: optionalNonEmptyString,
  appAppleId: z.union([z.number().int().positive(), numericStringSchema]),
  pushoverUserKey: optionalNonEmptyString,
  pushoverDevice: optionalNonEmptyString
});

const envSchema = z.object({
  WEBHOOK_SECRET: z.string().min(1),
  PUSHOVER_APP_TOKEN: z.string().min(1),
  PUSHOVER_USER_KEY: z.string().min(1),
  PUSHOVER_DEVICE: optionalNonEmptyString,
  APPLE_BUNDLE_ID: optionalNonEmptyString,
  APPLE_APP_ID: numericStringSchema.optional(),
  APPLE_APPS_JSON: optionalNonEmptyString,
  APPLE_ENABLE_ONLINE_CHECKS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  APPLE_ROOT_CA_DIR: z.string().default("certs/apple"),
  KV_REST_API_URL: z.string().url(),
  KV_REST_API_TOKEN: z.string().min(1)
});

export const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 30;

export type AppleAppConfig = {
  bundleId?: string;
  appAppleId: number;
  pushoverUserKey: string;
  pushoverDevice?: string;
};

export type AppConfig = {
  webhookSecret: string;
  pushoverAppToken: string;
  defaultPushoverUserKey: string;
  defaultPushoverDevice?: string;
  appleApps: AppleAppConfig[];
  appleEnableOnlineChecks: boolean;
  appleRootCaDir: string;
  kvRestApiUrl: string;
  kvRestApiToken: string;
  dedupeTtlSeconds: number;
};

function parseAppleApps(
  rawJson: string,
  defaultPushoverUserKey: string,
  defaultPushoverDevice: string | undefined
): AppleAppConfig[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    throw new Error("APPLE_APPS_JSON must be valid JSON.");
  }

  const parsedApps = z.array(appleAppEntrySchema).min(1).parse(parsedJson);
  const apps = parsedApps.map((app) => ({
    bundleId: app.bundleId,
    appAppleId: app.appAppleId,
    pushoverUserKey: app.pushoverUserKey ?? defaultPushoverUserKey,
    pushoverDevice: app.pushoverDevice ?? defaultPushoverDevice
  }));

  if (apps.length > 1 && apps.some((app) => !app.bundleId)) {
    throw new Error(
      "Each APPLE_APPS_JSON entry must include bundleId when multiple apps are configured."
    );
  }

  const seenBundleIds = new Set<string>();
  for (const app of apps) {
    if (!app.bundleId) {
      continue;
    }
    if (seenBundleIds.has(app.bundleId)) {
      throw new Error(`Duplicate bundleId in APPLE_APPS_JSON: '${app.bundleId}'.`);
    }
    seenBundleIds.add(app.bundleId);
  }

  return apps;
}

function buildSingleAppFallback(parsed: z.infer<typeof envSchema>): AppleAppConfig[] {
  if (parsed.APPLE_APP_ID === undefined) {
    throw new Error("APPLE_APP_ID is required when APPLE_APPS_JSON is not set.");
  }

  return [
    {
      bundleId: parsed.APPLE_BUNDLE_ID,
      appAppleId: parsed.APPLE_APP_ID,
      pushoverUserKey: parsed.PUSHOVER_USER_KEY,
      pushoverDevice: parsed.PUSHOVER_DEVICE
    }
  ];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const appleApps = parsed.APPLE_APPS_JSON
    ? parseAppleApps(
        parsed.APPLE_APPS_JSON,
        parsed.PUSHOVER_USER_KEY,
        parsed.PUSHOVER_DEVICE
      )
    : buildSingleAppFallback(parsed);

  return {
    webhookSecret: parsed.WEBHOOK_SECRET,
    pushoverAppToken: parsed.PUSHOVER_APP_TOKEN,
    defaultPushoverUserKey: parsed.PUSHOVER_USER_KEY,
    defaultPushoverDevice: parsed.PUSHOVER_DEVICE,
    appleApps,
    appleEnableOnlineChecks: parsed.APPLE_ENABLE_ONLINE_CHECKS,
    appleRootCaDir: parsed.APPLE_ROOT_CA_DIR,
    kvRestApiUrl: parsed.KV_REST_API_URL,
    kvRestApiToken: parsed.KV_REST_API_TOKEN,
    dedupeTtlSeconds: DEDUPE_TTL_SECONDS
  };
}
