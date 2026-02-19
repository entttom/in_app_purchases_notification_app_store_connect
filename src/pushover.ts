import type { AppConfig } from "./env";

export type PushoverTarget = {
  userKey?: string;
  device?: string;
};

export async function sendPushoverNotification(
  config: AppConfig,
  title: string,
  message: string,
  target?: PushoverTarget
): Promise<void> {
  const userKey = target?.userKey ?? config.defaultPushoverUserKey;
  const device = target?.device ?? config.defaultPushoverDevice;

  const body = new URLSearchParams({
    token: config.pushoverAppToken,
    user: userKey,
    title,
    message,
    priority: "0"
  });

  if (device) {
    body.set("device", device);
  }

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Pushover API request failed (${response.status}): ${responseText}`
    );
  }
}
