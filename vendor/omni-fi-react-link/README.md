# @omni-fi/react-link

[![CI](https://img.shields.io/github/actions/workflow/status/omni-fi-app/omni-fi-react-link/ci.yml?branch=main&label=CI)](https://github.com/omni-fi-app/omni-fi-react-link/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/omni-fi-app/omni-fi-react-link.svg)](./LICENSE)

Official React SDK for the [Omni-FI](https://omni-fi.co) Link widget. Provides a lightweight `useOmniFILink` hook that loads the Omni-FI Connect script from the CDN and manages the widget lifecycle.

---

## How it works

The widget runs in an **isolated hosted iframe**. Cross-Origin Resource Sharing (CORS) rules prevent the parent page from reading keystrokes, ensuring raw credentials never touch your application. On success, your `onSuccess` callback receives a payload containing one or more connections — each with both a stable `connectionId` (the persisted Connection's UUID) and an opaque `publicToken` you can exchange server-side.

```
Your App  →  link_token  →  Widget (isolated iframe)
Your App  ←  { connections: [{ publicToken, connectionId, institutionId, customerType? }] }  ←  Widget
```

---

## Installation

```bash
# Bun
bun add @omni-fi/react-link

# npm
npm install @omni-fi/react-link

# yarn
yarn add @omni-fi/react-link
```

Requires **React 18 or 19** as a peer dependency.

---

## Usage

```tsx
import { useOmniFILink } from "@omni-fi/react-link";

function ConnectButton({ linkToken }: { linkToken: string }) {
  const { open, isReady } = useOmniFILink({
    token: linkToken,
    onSuccess({ connections }) {
      for (const { publicToken, connectionId, institutionId, customerType } of connections) {
        // `connectionId` addresses the persisted Connection record directly
        // (e.g. PUT /connections/{id}/accounts). Exchange `publicToken` on
        // your server for an opaque API token when needed.
        console.log("Connected:", institutionId, customerType, connectionId, publicToken);
      }
    },
    onError(error) {
      console.error("Link error:", error.code, error.message);
    },
    onExit() {
      console.log("Widget closed.");
    },
  });

  return (
    <button onClick={open} disabled={!isReady}>
      Connect your bank
    </button>
  );
}
```

---

## Environments

Switch the CDN the SDK loads the widget script from by setting `env` on the
`useOmniFILink` config:

```tsx
useOmniFILink({
  token: linkToken,
  env: "staging", // 'development' | 'staging' | 'production' (default)
  onSuccess({ connections }) { /* … */ },
});
```

| `env`                    | Script loaded from                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `"production"` (default) | `https://cdn.omni-fi.co/v1/omni-fi-connect.js`                                            |
| `"staging"`              | `https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js`                                    |
| `"development"`          | `http://localhost:5173/omni-fi-connect.js` (expects a local Vite dev server on port 5173) |

The `/v1/` prefix is a non-breaking-upgrade path — a future `/v2/` bundle can
ship without breaking integrations pinned to `v1`.

### Advanced: pinning to a specific script URL

For version-pinning (e.g. `/v2/` once available) or for self-hosting under
exceptional circumstances, the `scriptUrl` field takes precedence over `env`
**for the loader script URL only**:

```tsx
useOmniFILink({
  token: linkToken,
  env: "production",                                          // 👈 must match the script's intended env
  scriptUrl: "https://cdn.omni-fi.co/v2/omni-fi-connect.js",
  onSuccess({ connections }) { /* … */ },
});
```

When both `env` and `scriptUrl` are supplied, **only the loader script URL**
is overridden by `scriptUrl`. The `environment` value the widget iframe
runtime receives is still derived from `env` (and still defaults to
`"production"`). If you pin `scriptUrl` to a staging or development build,
you **must** set the matching `env` — otherwise the loaded script and the
iframe origin will diverge:

```tsx
// 🚫 BAD — loads staging script but iframe runs as production
useOmniFILink({
  token: linkToken,
  scriptUrl: "https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js",
  // env omitted → defaults to "production" → iframe origin is connect.omni-fi.co
  // → CDN script and iframe env disagree
  onSuccess({ connections }) { /* … */ },
});

// ✅ GOOD — script and env both staging
useOmniFILink({
  token: linkToken,
  env: "staging",
  scriptUrl: "https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js",
  onSuccess({ connections }) { /* … */ },
});
```

### `env` is locked at mount

The loader script URL is resolved on first mount and the script tag is
injected into the page. Subsequent rerenders that change `env` (or
`scriptUrl`) are **ignored** — re-injecting would either race against
the original script or tear down any open widget. A `console.warn` fires
in development if the SDK sees `env` change post-mount. If you need to
switch environments at runtime, mount the hook on a new React `key` so
the whole component remounts cleanly.

---

## Creating a link token

The `token` prop is a short-lived `LinkToken` your server creates via the Omni-FI API before mounting the widget. It is never generated client-side.

```bash
POST /connections/link-token
Authorization: Bearer <your-api-key>
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com"
}
```

Pass the returned `LinkToken` value directly as the `token` prop.

### Customising the widget session

All five fields below are optional. Omitting them keeps the current default behaviour — nothing changes for existing integrations.

#### RequestedScopes — control the consent screen

By default the widget asks the end user to consent to four data categories. You can limit this to only what your integration actually needs:

```bash
POST /connections/link-token
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com",
  "RequestedScopes": ["accounts", "data"]
}
```

The consent screen then shows only "Account Access" and "Transaction Data" — a more targeted, trustworthy prompt for your users.

| Scope | Description |
|-------|-------------|
| `accounts` | Bank account balances, account numbers, and metadata |
| `insights` | Financial analytics and spending pattern analysis |
| `alerts` | Transaction notifications and balance alerts |
| `data` | Transaction history and statement data |

Omit `RequestedScopes` to show all four. Passing an unknown identifier or an empty array returns `400 VALIDATION_ERROR`.

---

#### AppName and AppLogoUrl — white-label the widget

Display your application's name and logo on the widget's consent screen:

```bash
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com",
  "AppName": "Acme Finance",
  "AppLogoUrl": "https://your-cdn.com/logo.png"
}
```

`AppName` falls back to your ApiClient's registered name if omitted. `AppLogoUrl` is only displayed if provided — the widget shows text-only branding otherwise. Useful when one ApiClient powers multiple products or environments and each needs its own branding.

---

#### AccountSelectionEnabled — skip the account-select step

After the user connects a bank, Omni-FI can show an account-selection screen where the user picks which accounts to import. You can override the default on a per-session basis:

```bash
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com",
  "AccountSelectionEnabled": false
}
```

`true` shows the account-selection step; `false` skips it and imports all accounts silently. Omit to inherit the setting configured on your ApiClient.

---

#### WebhookUrl — route events per session

By default, `connection.created` webhook events are sent to the URL configured on your ApiClient's `WebhookEndpoint`. You can route a specific session's events to a different URL:

```bash
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com",
  "WebhookUrl": "https://staging.your-app.com/webhooks/omni-fi"
}
```

The same signing secret from your registered `WebhookEndpoint` is used to sign the delivery — verify the `X-Omni-FI-Signature` header as normal. If you have not configured a `WebhookEndpoint` on your ApiClient, `WebhookUrl` is stored but no event is fired.

**Common use case:** route events from staging link tokens to your staging webhook receiver, and production tokens to your production receiver, without needing separate ApiClients.

---

## Testing your integration

Verifying your `onSuccess` / `onError` / `onEvent` handlers against real banks
is slow (you'd need test credentials at every institution) and non-deterministic
(timeouts and outages don't happen on demand). Sandbox mode gives you two
escape hatches: **magic-email credentials** that drive deterministic happy-,
MFA-, and error-paths through the real pipeline, and a **URL-param override**
for quick visual QA of the Error screen.

### Sandbox mode

Issue a sandbox `link_token` from your server by passing `Environment: 'sandbox'`
to the standard `POST /connections/link-token` endpoint described in
[Creating a link token](#creating-a-link-token):

```bash
POST /connections/link-token
{
  "ClientUserId": "user_123",
  "RedirectOrigin": "https://your-app.com",
  "Environment": "sandbox"
}
```

A sandbox-issued token causes the widget to display a "Sandbox Mode" banner
and intercept calls to real institutions — no live bank traffic ever happens.
The magic credentials and URL overrides below **only** work against
sandbox-mode tokens; production tokens treat them as ordinary failed logins.

### Testing the happy path

Use one of the universal sandbox emails with the password `sandbox_password`:

| Username                  | Password           | Behaviour                                                                                  |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `sandbox@example.com`     | `sandbox_password` | Happy path — no MFA branch, even on MFA-capable mocks.                                      |
| `sandbox.mfa@example.com` | `sandbox_password` | Triggers the MFA branch on MFA-capable institutions (`inst_mock_sms` / `inst_mock_email` / `inst_mock_totp`). |

Pair `sandbox.mfa@example.com` with one of the mock institutions to exercise a
specific MFA variant:

| Institution ID      | Display name             | `mfaType` | OTP code                    | Destination                  | Length |
| ------------------- | ------------------------ | --------- | --------------------------- | ---------------------------- | ------ |
| `inst_mock_sms`     | Mock SMS Bank            | `sms`     | `123456`                    | `+230 5*** 1234`             | 6      |
| `inst_mock_email`   | Mock Email Bank          | `email`   | `abcdef` (case-insensitive) | `j***@example.com`           | 6      |
| `inst_mock_totp`    | Mock Authenticator Bank  | `totp`    | `123456`                    | _(none — authenticator app)_ | 6      |

To exercise the no-MFA happy path on the same mocks, sign in with
`sandbox@example.com` instead of `sandbox.mfa@example.com` — that username
short-circuits the MFA branch on every MFA-capable mock.

> Any OTP other than the canonical code returns `LOGIN_FAILED`, useful for
> exercising the wrong-code error path against the real backend.

#### Resend

The Resend button on the widget's MFA screen is a real
`POST /sync/{jobId}/resend` call, not a cosmetic countdown — clicking
it bumps a server-side resend counter (capped at 3 per challenge) and
re-arms the cooldown. The countdown duration the widget displays is
sourced from the live job's `MfaResendCooldownSeconds` field, not
hardcoded. In **production**, the backend then triggers a fresh OTP
dispatch against the institution.

In **sandbox**, the mock institutions (`inst_mock_sms` /
`inst_mock_email`) participate in the resend bookkeeping (counter +
cooldown + `MfaResendRequestedAt` watermark) but no real OTP is
dispatched — the mock keeps accepting the same canonical OTP code
(`123456` / `abcdef`) across resends. That lets you exercise "wait near
cooldown, click Resend, get a fresh window" end-to-end against the
real backend timing without live bank traffic. TOTP
(`inst_mock_totp`) has no Resend control — RFC 6238 codes rotate on a
fixed 30s window, so the widget hides the button.

### Testing error states

For deterministic error-path testing, use one of the magic emails below. They
pass sandbox authentication, then deliberately fail at a specific point in the
connect / sync / account-select pipeline — exercising the real `omni-fi:error`
postMessage timing end-to-end (so your loading states, retry UX, and Sentry
breadcrumbs all see the same event ordering they would in production).

| Email                                          | Password           | Triggers                          | `onError` receives             |
| ---------------------------------------------- | ------------------ | --------------------------------- | ------------------------------ |
| `sandbox@example.com`                          | `sandbox_password` | Successful connection             | _(no error)_                   |
| `sandbox.mfa@example.com`                      | `sandbox_password` | MFA prompt                        | _(no error if OTP correct)_    |
| `sandbox.invalid-credentials@example.com`      | `sandbox_password` | Bank rejects login                | `AUTH_INVALID_CREDENTIALS`     |
| `sandbox.locked@example.com`                   | `sandbox_password` | Account locked                    | `AUTH_ACCOUNT_LOCKED`          |
| `sandbox.timeout@example.com`                  | `sandbox_password` | Sync times out                    | `INSTITUTION_TIMEOUT`          |
| `sandbox.unavailable@example.com`              | `sandbox_password` | Bank unavailable                  | `INSTITUTION_UNAVAILABLE`      |
| `sandbox.network-error@example.com`            | `sandbox_password` | Scraper can't reach bank          | `NETWORK_ERROR`                |
| `sandbox.account-not-found@example.com`        | `sandbox_password` | Account permissions reject        | `ACCOUNT_NOT_FOUND`            |
| `sandbox.ui-flow-broken@example.com`           | `sandbox_password` | Bank flow drift                   | `UI_FLOW_BROKEN`               |

> **Magic emails only work with `link_token`s issued for sandbox mode.** In
> production they hit the real bank's auth and fail like any other invalid
> login — there is no path for a real customer to accidentally trigger them.

The canonical reference for these emails lives in the [Omni-FI sandbox
docs](https://docs.omni-fi.co/sandbox#sandbox-error-simulation); the
table above is duplicated inline so it's discoverable on npm.

#### URL-param override (visual QA)

For fast visual QA of the Error screen without walking the credentials form,
add `widget_simulate_error=<TYPE>` to the link-token URL's query string and
open it directly in a browser tab. The widget jumps straight to the Error
screen with the chosen `errorType`. The SDK constructs the iframe URL
internally, so this override is for **direct-browser QA**, not for
programmatic navigation in your host app:

```text
https://link.omni-fi.co/?token=<YOUR_LINK_TOKEN>&widget_simulate_error=INSTITUTION_UNAVAILABLE
```

Note the `&` separator — the link-token URL already carries a `?token=…`
query parameter, so the override appends with `&`, not `?`.

Accepted values: every `errorType` in the table above, plus the session
variants (`SESSION_EXPIRED`, `SESSION_IDLE_EXPIRED`, `SESSION_REVOKED`).
The override is sandbox-only; production tokens ignore it.

> **Why the short session names?** The URL-param parser uses the widget's
> runtime `errorType` values, which are the short forms emitted on the
> `omni-fi:error` postMessage. The SDK's longer-form `OmniFIErrorCode` union
> members (`SESSION_TOKEN_EXPIRED`, `SESSION_TOKEN_IDLE_EXPIRED`,
> `SESSION_TOKEN_REVOKED`) are the HTTP API error codes returned by
> `POST /connections/...` calls — the widget maps them to the short
> runtime form before posting. Use the short form in the URL param; the
> SDK union's longer forms will be aligned in a follow-up release.

#### Routing errors in your host app

The idiomatic shape for `onError` is a single switch that maps each
`errorType` to either a user-facing toast, a Sentry breadcrumb, or a
fallback CTA. The example below groups the codes by what the user
should do about them:

```tsx
import { useOmniFILink, type OmniFIErrorCode } from "@omni-fi/react-link";

// Runtime error codes the widget emits that aren't yet in the exported
// `OmniFIErrorCode` union — see the TypeScript note below.
type SandboxErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_ACCOUNT_LOCKED"
  | "INSTITUTION_TIMEOUT"
  | "INSTITUTION_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "ACCOUNT_NOT_FOUND"
  | "UI_FLOW_BROKEN";

type ExtendedErrorCode = OmniFIErrorCode | SandboxErrorCode;

const { open, isReady } = useOmniFILink({
  token: linkToken,
  onSuccess({ connections }) { /* exchange publicTokens server-side */ },
  onError(error) {
    switch (error.code as ExtendedErrorCode) {
      case "AUTH_INVALID_CREDENTIALS":
      case "AUTH_ACCOUNT_LOCKED":
        toast.error("We couldn't sign you in. Please check with your bank.");
        break;
      case "INSTITUTION_TIMEOUT":
      case "INSTITUTION_UNAVAILABLE":
      case "NETWORK_ERROR":
      case "UI_FLOW_BROKEN":
        toast.warning("Your bank is unavailable right now. Try again in a few minutes.");
        break;
      case "ACCOUNT_NOT_FOUND":
        toast.error("One of your accounts is no longer available. Please retry.");
        break;
      default:
        Sentry.captureMessage("Omni-FI Link error", { extra: error });
        toast.error("Something went wrong. Please try again.");
    }
  },
});
```

#### Inline (non-terminal) errors — `onEvent('omni-fi:inline-error', metadata)`

Some bank failures don't end the widget session — incorrect
credentials, wrong OTP, an account-permissions rejection. The user
can fix these in place: type the password again, re-enter the OTP,
deselect the bad account. For these cases the widget shows an inline
error in the form **and** fires a non-terminal `omni-fi:inline-error`
event so your host page can record the attempt without treating the
session as finished. The terminal-only `onError` callback does NOT
fire for these — that's the channel reserved for "the widget gave up".

Subscribe via `onEvent`. The event's `metadata` arrives typed as the
SDK's generic `Record<string, unknown>` (one signature handles every
intermediate event), so define a payload type and narrow at the event
guard:

```tsx
type InlineErrorPayload = {
  code: string;
  message: string;
  screen: "credentials" | "mfa" | "account_select";
  institutionId: string | null;
};

useOmniFILink({
  token: linkToken,
  onSuccess({ connections }) { /* ... */ },
  onError(error) { /* terminal — show fallback CTA */ },
  onEvent(eventName, metadata) {
    if (eventName === "omni-fi:inline-error" && metadata) {
      const inline = metadata as InlineErrorPayload;

      Sentry.addBreadcrumb({
        category: "omni-fi",
        level: "warning",
        data: inline,
      });
      // Optional analytics: attribute drop-off to the specific screen
      analytics.track("Bank Link Inline Error", {
        code: inline.code,
        screen: inline.screen,
      });
    }
  },
});
```

| `code` value             | Screen           | Triggered by                                                |
| ------------------------ | ---------------- | ----------------------------------------------------------- |
| `AUTH_INVALID_CREDENTIALS` | credentials    | Bank rejects login                                          |
| `AUTH_ACCOUNT_LOCKED`    | credentials      | Bank reports account locked                                 |
| `LOGIN_FAILED`           | credentials      | Generic credential rejection                                |
| `LOGIN_SHAPE_INVALID`    | credentials      | Client-side: email / phone shape doesn't match `LoginFormat` |
| `INSTITUTION_LOCKED`     | credentials      | Bank scraper temporarily locked institution-wide            |
| `WRONG_OTP_CODE`         | mfa              | OTP submitted doesn't match                                  |
| `MFA_SUBMIT_FAILED`      | mfa              | Transport / 5xx during OTP POST                              |
| `ACCOUNT_NOT_FOUND`      | account_select   | Permissions endpoint rejects an account ID                  |
| `TOO_MANY_ACCOUNTS_SELECTED` | account_select | Client-side: exceeds backend cap                            |
| `PERMISSIONS_FAILED`     | account_select   | Generic permissions endpoint failure                        |

`metadata.screen` is one of `'credentials'` / `'mfa'` / `'account_select'` — useful for funnel analytics. `metadata.institutionId` may be `null` if the user hasn't selected a bank yet.

> **When to use `onEvent` vs `onError`.** Treat `omni-fi:error` as
> a terminal signal — the widget will land on the Error screen
> and the user is no longer in the connect flow. Treat
> `omni-fi:inline-error` as a breadcrumb — the user is still in
> the flow and may still complete the connection. A typical
> integration captures *every* `inline-error` to Sentry/analytics
> but only surfaces toasts on `error`.

> **TypeScript note.** The `as ExtendedErrorCode` cast at the switch is
> necessary because the seven codes above (`AUTH_INVALID_CREDENTIALS`,
> `AUTH_ACCOUNT_LOCKED`, `INSTITUTION_TIMEOUT`, `INSTITUTION_UNAVAILABLE`,
> `NETWORK_ERROR`, `ACCOUNT_NOT_FOUND`, `UI_FLOW_BROKEN`) are runtime values
> emitted by the backend but are not yet part of the exported
> `OmniFIErrorCode` union — that widening will land in a follow-up SDK
> release once the backend producer side ships. The cast-at-boundary
> pattern shown above is the idiomatic workaround.
>
> Declaration merging via `declare module '@omni-fi/react-link'` won't work
> here — `OmniFIErrorCode` is a `type` alias rather than an `interface`, and
> TypeScript only supports merging on interfaces and (with caveats) modules.
> The cast-at-boundary pattern above keeps the rest of your code fully
> type-safe.

---

## API

### `useOmniFILink(config: OmniFIConfig)`

| Property  | Type         | Description                                      |
| --------- | ------------ | ------------------------------------------------ |
| `open`    | `() => void` | Opens the Link widget modal/popup.               |
| `destroy` | `() => void` | Closes the widget and cleans up its handlers. Called automatically on unmount. |
| `isReady` | `boolean`    | `true` once the CDN script has loaded.           |
| `error`   | `Error \| null` | Set if the CDN script fails to load.          |

### `OmniFIConfig`

| Property      | Type                                   | Required | Description                                |
| ------------- | -------------------------------------- | -------- | ------------------------------------------ |
| `token`       | `string`                                      | Yes      | Short-lived `link_token` from your server. |
| `onSuccess`   | `(payload: OmniFISuccessPayload) => void`     | Yes      | Called once all connections are complete. `payload.connections` is an array of `{ publicToken, connectionId, institutionId, customerType?, permittedAccountIds? }`. `connectionId` is the persisted Connection's UUID — addressable via the connection-scoped REST endpoints; `publicToken` is the opaque token you exchange server-side. `customerType` and `permittedAccountIds` are optional (the widget may emit `connection-linked` before either is resolved, and B2B flows auto-confirm accounts). |
| `onError`     | `(error: OmniFIError) => void`                | No       | Called when the widget reports an error. |
| `onExit`      | `() => void`                                  | No       | Called when the user closes the widget without completing. |
| `onEvent`     | `(eventName: string, metadata?: Record<string, unknown>) => void` | No       | Called for intermediate events (e.g., `omni-fi:connection-linked` per bank linked). |
| `displayMode` | `'iframe' \| 'popup'`                         | No       | Defaults to `iframe`.                      |
| `env`         | `'development' \| 'staging' \| 'production'`  | No       | Defaults to `production`. See [Environments](#environments) — single source of truth for both the CDN URL and the widget runtime env signal. |
| `scriptUrl`   | `string`                                      | No       | Advanced: override the CDN script URL for version pinning or self-hosting. Takes precedence over `env` when both are set. See [Environments](#environments). |

---

## MFA handling

The hosted widget handles multi-factor authentication **internally** — when an
institution requests an OTP, the widget renders its own OTP screen, collects
the code, submits it, and (on success) advances to Account-Select transparently
from the SDK consumer's perspective. There is **no** `omni-fi:mfa-challenge`
event today, so subscribing to one via `onEvent` would never fire.

> **Future surface.** MFA delivery metadata (`mfaDestination`,
> `mfaDestinationKind`, `mfaLength`) is part of the widget's internal contract
> with the backend but is not yet surfaced as an `onEvent` callback. The SDK
> will expose `omni-fi:mfa-challenge` (and a typed payload) in a follow-up
> release once the widget producer side ships. The institution-level
> `OmniFIMfaType` union is already exported for forward compatibility.

---

## Development

### Test convention

TypeScript tests are co-located alongside source files as `*.test.ts`. Do not use `__tests__/` directories.

```
src/
├── useOmniFILink.ts
├── useOmniFILink.test.ts       ← co-located unit tests
├── sdk-passthrough.test.ts     ← co-located regression tests
└── types.ts
```

Run tests with:

```bash
bun test
```

---

## License

[MIT](./LICENSE) © 2026 Omni-FI

## Continuous Integration

CI follows the Omni-FI house style — see [`omni-fi-app/.github` → CI_CONVENTIONS.md](https://github.com/omni-fi-app/.github/blob/main/CI_CONVENTIONS.md).

- **CI** (`.github/workflows/ci.yml`): job `CI`, Bun 1.3.14 + pinned Node (`.nvmrc`), SHA-pinned actions, least-privilege permissions, concurrency. Phases: Install → Lint → Build → Test.
- **Code scanning**: GitHub *default* code-scanning setup (public repo — free).
- **Dependabot** (`.github/dependabot.yml`): `github-actions` + `bun`, weekly, `chore(deps)`.
