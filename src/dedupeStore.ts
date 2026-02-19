import { Redis } from "@upstash/redis";
import type { AppConfig } from "./env";

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

function getDedupeKey(notificationUUID: string): string {
  return `appstore:notification:${notificationUUID}`;
}

export async function markNotificationAsNew(
  notificationUUID: string,
  config: AppConfig
): Promise<boolean> {
  const redis = getRedisClient(config);
  const key = getDedupeKey(notificationUUID);

  const result = await redis.set(key, "1", {
    ex: config.dedupeTtlSeconds,
    nx: true
  });

  return result === "OK";
}
