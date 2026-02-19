import type { ClassifiedAction } from "./eventClassifier";

type PushableAction = Exclude<ClassifiedAction, "IGNORE">;

export type MessageInput = {
  action: PushableAction;
  appBundleId: string;
  notificationType: string;
  environment: string;
  productId?: string;
  transactionId?: string;
  price?: number;
  currency?: string;
};

export type PushoverMessage = {
  title: string;
  message: string;
};

function shortTransactionId(transactionId: string | undefined): string {
  if (!transactionId) {
    return "n/a";
  }

  if (transactionId.length <= 12) {
    return transactionId;
  }

  return `${transactionId.slice(0, 6)}...${transactionId.slice(-4)}`;
}

function formatAmount(price: number | undefined, currency: string | undefined): string {
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return "n/a";
  }

  if (currency) {
    return `${price} ${currency}`;
  }

  return String(price);
}

export function buildPushoverMessage(input: MessageInput): PushoverMessage {
  const title = input.action === "PURCHASE" ? "In-App Kauf" : "Refund";

  const parts = [
    `app=${input.appBundleId}`,
    `type=${input.notificationType}`,
    `product=${input.productId ?? "n/a"}`,
    `env=${input.environment}`,
    `tx=${shortTransactionId(input.transactionId)}`
  ];

  const amount = formatAmount(input.price, input.currency);
  if (amount !== "n/a") {
    parts.push(`amount=${amount}`);
  }

  return {
    title,
    message: parts.join(" | ")
  };
}
