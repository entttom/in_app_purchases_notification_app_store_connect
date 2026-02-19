import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createWebhookHandler } from "../../src/webhookHandler";

const handler = createWebhookHandler();

export default async function appStoreNotificationsHandler(
  request: VercelRequest,
  response: VercelResponse
): Promise<void> {
  await handler(request, response);
}
