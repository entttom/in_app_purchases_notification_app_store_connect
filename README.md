# App Store Server Notifications to Pushover (Vercel)

Production-ready webhook for Apple App Store Server Notifications V2.

It verifies Apple-signed payloads, filters purchase/refund events, deduplicates notifications with Upstash Redis, and sends concise alerts through Pushover.

## What This Service Does

- Exposes a Vercel endpoint at `POST /api/app-store-notifications/<WEBHOOK_SECRET>`
- Verifies `signedPayload` using Apple's official App Store Server library
- Supports both Sandbox and Production notifications
- Handles single-app and multi-app configurations
- Deduplicates by `notificationUUID` for 30 days
- Sends Pushover notifications only for selected event types
- Returns deterministic HTTP status codes so Apple retry behavior works as expected

## Request and Processing Flow

1. Apple calls the webhook with a signed `signedPayload`.
2. The handler checks HTTP method (`POST`) and URL secret.
3. The payload signature is verified against Apple root certificates.
4. Notification type is classified:
   - `PURCHASE`: `SUBSCRIBED`, `DID_RENEW`, `ONE_TIME_CHARGE`
   - `REFUND`: `REFUND`
   - everything else is ignored
5. `notificationUUID` is written to Upstash Redis using `SET NX EX`.
6. If the UUID is new, a Pushover message is sent.
7. Structured JSON log entry is emitted (`ignored`, `deduped`, `pushed`, `error`).

## Endpoint Contract

- Route: `POST /api/app-store-notifications/:secret`
- Example:
  - `https://<your-domain>/api/app-store-notifications/<WEBHOOK_SECRET>`
- Body: JSON with `signedPayload` (string)

### Response Codes

- `200 OK`: processed successfully, ignored event, or duplicate event
- `400 Bad Request`: missing/invalid payload or failed signature verification
- `404 Not Found`: URL secret mismatch
- `405 Method Not Allowed`: non-`POST` request
- `500 Internal Server Error`: temporary downstream/config issue (e.g., Upstash/Pushover); Apple can retry

## Supported Notification Types

### Triggers Pushover

- `SUBSCRIBED`
- `DID_RENEW`
- `ONE_TIME_CHARGE`
- `REFUND`

### Acknowledged but Ignored

- Any other App Store notification type

## Message Format (Pushover)

- Title:
  - `In-App Kauf` for purchase events
  - `Refund` for refund events
- Message fields include:
  - `app=<bundleId>`
  - `type=<notificationType>`
  - `product=<productId>`
  - `env=<environment>`
  - `tx=<shortTransactionId>`
  - optional: `amount=<price currency>`

## Project Structure

```text
api/
  app-store-notifications/[secret].ts   # Vercel API route
src/
  webhookHandler.ts                     # Main request workflow
  appleVerifier.ts                      # Apple signature verification + payload decoding
  eventClassifier.ts                    # Maps notificationType -> PURCHASE/REFUND/IGNORE
  messageBuilder.ts                     # Builds push title/body
  dedupeStore.ts                        # Upstash Redis dedupe (SET NX EX)
  pushover.ts                           # Pushover API integration
  env.ts                                # Environment validation (zod)
tests/
  webhook.test.ts                       # Unit tests for handler behavior
certs/apple/                            # Apple root certificates
```

## Requirements

- Node.js 20+ (Vercel runtime is `nodejs20.x`)
- Vercel project (for deployment)
- Pushover application token + user key
- Upstash Redis REST credentials
- Apple root certificates on disk

## Setup

1. Install dependencies:

```bash
npm install
```

2. Add Apple root certificates (`.cer`, `.crt`, `.pem`, or `.der`) to:

```text
certs/apple/
```

3. Configure environment variables (local `.env` and/or Vercel project settings).
4. Run checks:

```bash
npm run typecheck
npm test
```

5. Start local development:

```bash
npm run dev
```

Vercel prints the local URL. Use the matching local endpoint including your secret path.

## Environment Variables

### Required

| Variable | Description |
| --- | --- |
| `WEBHOOK_SECRET` | Secret path segment used in `/api/app-store-notifications/<secret>` |
| `PUSHOVER_APP_TOKEN` | Pushover application API token |
| `PUSHOVER_USER_KEY` | Default target user key for push notifications |
| `KV_REST_API_URL` | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Upstash Redis REST token |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `PUSHOVER_DEVICE` | unset | Default Pushover target device |
| `APPLE_APPS_JSON` | unset | JSON array for multi-app (or advanced single-app) mapping |
| `APPLE_APP_ID` | unset | Required when `APPLE_APPS_JSON` is not set |
| `APPLE_BUNDLE_ID` | unset | Optional in single-app mode, recommended for strict bundle binding |
| `APPLE_ENABLE_ONLINE_CHECKS` | `false` | Enables online certificate checks in Apple verifier |
| `APPLE_ROOT_CA_DIR` | `certs/apple` | Directory containing Apple root certificates |

## App Configuration Modes

### Single-App Mode

Used when `APPLE_APPS_JSON` is not provided.

Required:
- `APPLE_APP_ID`

Recommended:
- `APPLE_BUNDLE_ID`

### Multi-App Mode (`APPLE_APPS_JSON`)

Set `APPLE_APPS_JSON` to a JSON array:

```json
[
  {
    "bundleId": "com.example.app1",
    "appAppleId": 1234567890
  },
  {
    "bundleId": "com.example.app2",
    "appAppleId": 2345678901,
    "pushoverUserKey": "user-key-override",
    "pushoverDevice": "iphone-override"
  }
]
```

Validation rules:

- At least one entry is required.
- `bundleId` is required for each entry when multiple apps are configured.
- Duplicate `bundleId` values are rejected.
- `pushoverUserKey` and `pushoverDevice` can override global defaults per app.

## Certificate Handling

The verifier loads root certificates from `APPLE_ROOT_CA_DIR` (absolute path or path relative to project root).

Behavior:

- Missing directory -> configuration error
- Empty directory -> configuration error
- Supported extensions: `.cer`, `.crt`, `.pem`, `.der`

## App Store Connect Configuration

1. Deploy the project to Vercel.
2. Add all required environment variables in Vercel project settings.
3. In App Store Connect, configure App Store Server Notifications V2:
   - URL: `https://<your-domain>/api/app-store-notifications/<WEBHOOK_SECRET>`
   - Enable for Sandbox and Production
4. Send a test notification and verify one Pushover message is received.

## Reliability and Idempotency

- Deduplication key: `appstore:notification:<notificationUUID>`
- Storage: Upstash Redis REST
- TTL: `30 days` (`2,592,000` seconds)
- Effect:
  - first time UUID: process + send push
  - repeated UUID: skip push, return `200`

If Redis or Pushover fails, the endpoint returns `500`, allowing Apple to retry later.

## Logging

Each request emits structured logs suitable for log aggregation:

- `ignored`
- `deduped`
- `pushed`
- `error`

Additional metadata includes notification UUID, notification type, environment, and error message (when present).

## Testing

Run unit tests:

```bash
npm test
```

Current tests cover:

- valid purchase flow
- refund flow
- ignored event flow
- dedupe behavior
- invalid secret
- invalid payload
- signature verification failure
- downstream failures (dedupe/pushover)

## Troubleshooting

| Error | Meaning | Typical Fix |
| --- | --- | --- |
| `invalid_configuration` (`500`) | Missing/invalid environment variables or cert setup | Validate env values and certificate directory |
| `invalid_payload` (`400`) | Missing or malformed `signedPayload` | Ensure JSON body contains `signedPayload` string |
| `invalid_signature` (`400`) | Verification failed | Verify root certs, bundle/app mapping, and signed payload integrity |
| `not_found` (`404`) | Secret in URL does not match `WEBHOOK_SECRET` | Update endpoint URL in App Store Connect |
| `method_not_allowed` (`405`) | Request is not `POST` | Send `POST` requests only |
| `internal_error` (`500`) | Redis/Pushover or other runtime failure | Check logs, service health, and retry behavior |

## Security Notes

- Keep `WEBHOOK_SECRET`, Pushover credentials, and Upstash tokens in secure secret storage.
- Never commit real credentials.
- Restrict access to logs if they may contain operational metadata.
