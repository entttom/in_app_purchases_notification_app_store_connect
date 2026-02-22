import type { ClassifiedAction } from "./eventClassifier";

type PushableAction = Exclude<ClassifiedAction, "IGNORE">;

export type MessageInput = {
  action: PushableAction;
  appBundleId: string;
  notificationType: string;
  subtype?: string | null;
  environment: string;
  productId?: string;
  transactionId?: string;
  transactionReason?: string;
  offerDiscountType?: string;
  subscriptionLifecycle?: string;
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

  // Apple sends transaction prices in milliunits.
  const amountInMajorUnit = price / 1000;
  const formattedAmount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
    useGrouping: false
  }).format(amountInMajorUnit);

  if (currency) {
    return `${formattedAmount} ${currency}`;
  }

  return formattedAmount;
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

  if (input.subtype) {
    parts.push(`subtype=${input.subtype}`);
  }

  if (input.transactionReason) {
    parts.push(`reason=${input.transactionReason}`);
  }

  if (input.offerDiscountType) {
    parts.push(`offer=${input.offerDiscountType}`);
  }

  if (input.subscriptionLifecycle) {
    parts.push(`lifecycle=${input.subscriptionLifecycle}`);
  }

  const amount = formatAmount(input.price, input.currency);
  if (amount !== "n/a") {
    parts.push(`amount=${amount}`);
  }

  return {
    title,
    message: parts.join(" | ")
  };
}
