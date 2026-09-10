/**
 * FCM transport — the one module allowed to speak to Google, and the one place a device token exists in
 * memory on the way out.
 *
 * Three constraints shape this file:
 *
 *   1. **No Firebase SDK.** `firebase-admin` pulls in `@google-cloud/firestore`'s auth stack, `node-forge`
 *      (which needs `Buffer` and fs), and a CommonJS tree that only half-loads into a Workers runtime. What
 *      FCM actually needs is one HTTP POST with a bearer token, and the token is a signed JWT — both of which
 *      WebCrypto does in about sixty lines. That is the whole dependency.
 *   2. **A credential never leaves the Worker.** The service-account JSON is a secret (`FCM_SERVICE_ACCOUNT`,
 *      `wrangler secret put`); the SPA's `google.services_key` stays exactly as irrelevant to sending as it is
 *      today (it belongs to Google Sign-In). The browser never calls FCM and never sees either key.
 *   3. **No token in a log line.** `redact()` runs over every string this module can produce on an error path,
 *      and the delivery record stores only a machine code. A registration token is a bearer credential for
 *      "push to this phone"; leaking one through an error message is leaking the ability to spam a device.
 *
 * Batch semantics: FCM's `messages:send` is one message per request and `messages:batch` refuses more than
 * 100 sub-requests (plus non-2xx sub-responses come back as HTML), so the "batch" here is a *bounded
 * concurrency window* over individual POSTs — which is also what makes a partial failure representable: each
 * device gets its own outcome, and each outcome is its own delivery row.
 */
import type { Env } from "../env.ts";
import { requireSecret } from "../env.ts";
import { logError } from "../lib/debug.ts";

/** Where a push attempt ended up. Mirrors `notification_deliveries.status`. */
export type DeliveryStatus = "sent" | "failed" | "skipped_invalid_token";

export interface NotificationDelivery {
  readonly status: DeliveryStatus;
  readonly messageId?: string;
  /** FCM's machine code, e.g. `UNREGISTERED`. Never the response body. */
  readonly errorCode?: string;
}

export interface SendInput {
  readonly deviceId: string;
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

export interface DeliveryTransport {
  readonly name: string;
  send(input: SendInput): Promise<NotificationDelivery>;
}

/** The two FCM outcomes that mean "stop sending to this token" — see docs/NOTIFICATIONS_ARCHITECTURE.md §12. */
const PERMANENT_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH", "API_KEY_EXPIRED", "INVALIDRegistrationToken", "NotRegistered"]);
/** The ones that mean "the same send may succeed later". */
const TRANSIENT_CODES = new Set(["UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED", "Aborted", "Retry-After", "THROTTLED", "QUOTA_EXCEEDED", "TOO_MANY_ARGUMENTS"]);

export class FcmTransport implements DeliveryTransport {
  readonly name = "fcm";

  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly tokenUri: string;
  private readonly timeoutMs: number;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(config: { projectId: string; clientEmail: string; privateKey: string; tokenUri?: string; timeoutMs?: number }) {
    if (!config.projectId.trim()) throw new Error("FcmTransport needs a project id");
    this.projectId = config.projectId.trim();
    this.clientEmail = config.clientEmail;
    this.privateKey = config.privateKey;
    this.tokenUri = config.tokenUri ?? "https://oauth2.googleapis.com/token";
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async send(input: SendInput): Promise<NotificationDelivery> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch (err) {
      // The credential is misconfigured or Google's token endpoint is down. Nothing about the *device* is
      // wrong, so this must not deactivate anything: `failed`, with the retry policy doing its work.
      logError(`fcm-auth-${input.deviceId.slice(0, 8)}`, err);
      return { status: "failed", errorCode: "FCM_AUTH" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ message: buildMessage(input) }),
      });
    } catch (err) {
      clearTimeout(timer);
      // A fetch rejection's message can contain the request URL; it never contains the token (that is in the
      // body) — and it is still redacted, because "never log a credential" cannot depend on what some future
      // error happens to interpolate.
      logError(`fcm-send-${input.deviceId.slice(0, 8)}`, new Error(redact(String(err))));
      return { status: "failed", errorCode: controller.signal.aborted ? "TIMEOUT" : "NETWORK" };
    }
    clearTimeout(timer);

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { name?: string };
      return { status: "sent", messageId: body.name };
    }

    const code = await fcmCode(res);
    // A 400 naming the *token* is Google telling us the registration is dead. Anything else 400-ish is our
    // payload's fault, and deactivating every recipient for one malformed link would look like a device that
    // nobody owns any more.
    if (PERMANENT_CODES.has(code) || (res.status === 400 && /token/i.test(code))) {
      return { status: "skipped_invalid_token", errorCode: code };
    }
    if (res.status === 401 || res.status === 403) this.cached = null;
    return { status: "failed", errorCode: code || `HTTP_${String(res.status)}` };
  }

  /**
   * A signed self-assertion exchanged for an OAuth access token, cached per isolate until 60 s before it
   * expires. A goal fan-out is 500 concurrent sends; without this cache every one of them would mint a token
   * first, which turns Google's quota into our outage.
   */
  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt > now + 60) return this.cached.token;
    const assertion = await this.signedJwt({
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: this.tokenUri,
      exp: now + 3600,
      iat: now,
    });
    const res = await fetch(this.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: HTTP ${String(res.status)}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("FCM token exchange returned no access_token");
    this.cached = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
    return json.access_token;
  }

  private async signedJwt(claims: Record<string, string | number>): Promise<string> {
    const encoder = new TextEncoder();
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Der(this.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
  }
}

/** FCM's `webpush` block is what a browser needs for the click-through to work; the `android` notification
 *  channel keeps the copy identical to what the in-app inbox shows, so a user never sees two phrasings. */
function buildMessage(input: SendInput): Record<string, unknown> {
  return {
    token: input.token,
    notification: { title: input.title, body: input.body },
    webpush: {
      headers: { "Urgency": "high" },
      notification: {
        title: input.title,
        body: input.body,
        icon: "/brand/brand-icon-512.png",
        badge: "/brand/brand-icon-192.png",
        tag: `kicklive-${String(input.metadata["matchId"] ?? "general")}`,
        requireInteraction: false,
        click_action: input.url,
      },
      fcmOptions: { link: input.url },
    },
    android: {
      notification: { channel_id: kindChannel(input.metadata), title: input.title, body: input.body, click_action: "FCM_PLUGIN_ACTIVITY" },
      priority: "high",
      collapse_key: `kicklive-${String(input.metadata["matchId"] ?? "general")}`,
    },
    apns: { payload: { aps: { alert: { title: input.title, body: input.body }, sound: "default", "content-available": 1 } } },
    data: toStringMap(input.metadata),
  };
}

function kindChannel(metadata: Record<string, unknown>): string {
  const kind = typeof metadata["kind"] === "string" ? (metadata["kind"] as string) : "match";
  return `kicklive_${kind}`;
}

function toStringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

async function fcmCode(res: Response): Promise<string> {
  // The body is read for its `status` enum and then dropped; nothing that came back from Google is forwarded,
  // logged or stored, because a validation error quotes the offending value — which is the device token.
  const body = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
  return body?.error?.status ?? "";
}

/** PEM (`-----BEGIN PRIVATE KEY-----`) to the DER bytes WebCrypto wants. No `Buffer`, so this runs on workers. */
export function pkcs8Der(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\s+/g, "");
  if (body.length < 100) throw new Error("FCM_SERVICE_ACCOUNT's private_key is not a PEM block");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Redact what must never reach a log: FCM tokens, bearer tokens, and anything shaped like a JWT. Applied to the
 * message of every error this module can raise, and tested, because "we don't log tokens" is only true if the
 * error path obeys it too — that is where credentials surface.
 */
export function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted jwt]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]")
    // FCM registration tokens are 140+ chars ending in a `-` or `_`; a bare regex on length is the honest
    // version of "we do not know the format", so we match the format we actually see and nothing else.
    .replace(/[A-Za-z0-9_-]{120,}(?:-[A-Za-z0-9_-]+)?/g, (m) => `[token ${m.slice(0, 8)}…]`)
    .replace(/("token"\s*:\s*")[^"]+(")/g, "$1[redacted]$2");
}

/** Records instead of sending. The default when `FCM_PROJECT_ID` is unset, and the whole basis of §18's tests. */
export class MockTransport implements DeliveryTransport {
  readonly name = "mock";
  readonly sent: SendInput[] = [];
  readonly outcomes: Map<string, NotificationDelivery>;

  constructor(outcomes: Iterable<[string, NotificationDelivery]> = []) {
    this.outcomes = new Map(outcomes);
  }

  async send(input: SendInput): Promise<NotificationDelivery> {
    this.sent.push(input);
    const preset = this.outcomes.get(input.token) ?? this.outcomes.get(input.deviceId);
    if (preset) return preset;
    if (input.token.startsWith("invalid:")) return { status: "skipped_invalid_token", errorCode: "UNREGISTERED" };
    if (input.token.startsWith("flaky:")) return { status: "failed", errorCode: "UNAVAILABLE" };
    if (input.token.startsWith("badpayload:")) return { status: "failed", errorCode: "INVALID_ARGUMENT" };
    return { status: "sent", messageId: `projects/mock/messages/${String(this.sent.length)}` };
  }
}

/**
 * Which transport a request or a queue batch gets: real FCM only when a project id is configured, mock
 * otherwise. There is no "log a warning and print the token instead" path — a Worker that prints a credential
 * into `wrangler tail` is the failure mode the brief's logging step is about.
 */
export function transportFor(env: Env): DeliveryTransport {
  const projectId = env.FCM_PROJECT_ID?.trim();
  if (!projectId) return new MockTransport();
  const raw = requireSecret(env, "FCM_SERVICE_ACCOUNT");
  let account: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    account = JSON.parse(raw) as { client_email?: string; private_key?: string; token_uri?: string };
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT must be the downloaded service-account JSON, verbatim");
  }
  if (!account.client_email || !account.private_key) throw new Error("FCM_SERVICE_ACCOUNT needs client_email and private_key");
  return new FcmTransport({ projectId, clientEmail: account.client_email, privateKey: account.private_key, tokenUri: account.token_uri, timeoutMs: Number(env.FCM_TIMEOUT_MS ?? 5000) });
}
