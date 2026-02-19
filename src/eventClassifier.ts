export type ClassifiedAction = "PURCHASE" | "REFUND" | "IGNORE";

const PURCHASE_NOTIFICATION_TYPES = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "ONE_TIME_CHARGE"
]);

export function classifyNotificationType(notificationType: string): ClassifiedAction {
  if (notificationType === "REFUND") {
    return "REFUND";
  }

  if (PURCHASE_NOTIFICATION_TYPES.has(notificationType)) {
    return "PURCHASE";
  }

  return "IGNORE";
}
