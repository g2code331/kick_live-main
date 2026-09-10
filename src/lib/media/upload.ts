/**
 * Phase 6: the upload client.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason and one reason only:
 * `fetch` reports no upload progress. A 9 MB crest on a stadium wifi otherwise
 * looks like a frozen form, and a frozen form gets navigated away from, which is
 * how an upload ends up half-done in a way nobody can see. XHR also gives the
 * Cancel button something real to do — `abort()` stops the bytes instead of
 * leaving a request the server still has to finish paying for.
 *
 * Everything else about this file is deliberately boring: the endpoint is derived
 * from the same base URL as the API client (so an image and the JSON describing it
 * can never be sent to different hosts), the bearer token is read fresh per upload
 * (never cached here), and a failure is turned into one typed error the form can
 * branch on instead of a string to match prose against.
 */
import { readAccessToken } from "../api/index.ts";
import { mediaUploadEndpoint, sponsorBrandingEndpoint } from "./assets.ts";

export type MediaUploadKind = "teams" | "players" | "competitions" | "news" | "team_news" | "users";

export interface MediaUploadResult {
  assetId: number;
  url: string;
  objectKey: string;
  version: number;
  bytes: number;
  contentType: string;
  width: number | null;
  height: number | null;
  /** True when the identical bytes were already stored for this slot, so nothing
   *  was written and no new version was made. Worth surfacing: it is the difference
   *  between "uploaded" and "already there", and a user who re-picks the same file
   *  deserves to know the second pick cost nothing. */
  reused: boolean;
}

export class MediaUploadError extends Error {
  readonly status: number;
  readonly code: string;
  /** The machine-readable refusal from the Worker (`TOO_LARGE`, `UNSUPPORTED_TYPE`,
   *  `QUOTA_EXCEEDED`, `NOT_YOUR_CLUB`), kept separate from the message so a form
   *  can react to the reason instead of parsing prose. */
  readonly reason: string | null;
  /** Whether asking again could possibly succeed. A rejected *file* is never
   *  retryable — the honest retry is to pick another file — while an outage, a
   *  timeout and an aborted-by-clock request all are. */
  readonly retryable: boolean;

  constructor(message: string, init: { status: number; code: string; reason?: string | null; retryable?: boolean }) {
    super(message);
    this.name = "MediaUploadError";
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason ?? null;
    this.retryable = init.retryable ?? false;
  }
}

export function isMediaUploadError(err: unknown): err is MediaUploadError {
  return err instanceof MediaUploadError;
}

export interface UploadOptions {
  file: File | Blob;
  kind: MediaUploadKind;
  entityId: string | number;
  alt?: string | null;
  onProgress?: (fraction: number, loadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Client-side deadline in ms. The Worker bounds the *body*, not the clock, and a
   *  proxy that swallows a request silently is a real deployment failure mode: with
   *  no deadline the spinner runs until the tab is closed. */
  timeoutMs?: number;
  /** For a `File`, the name is only cosmetic (the Worker ignores it — the type comes
   *  from the bytes), but `Blob`s need one to be a sensible form part. */
  filename?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * One transport, two entry points. The XHR, the progress callback, the deadline, the abort, the single-settle
 * guard and the error mapping all live here; what differs between a club crest and a sponsor's logo is the
 * endpoint and the field names — which is exactly the seam worth having, because a second copy of this
 * function is a second place to forget the deadline or the `Authorization: Bearer null` rule.
 */
interface MultipartSend {
  endpoint: string;
  /** Text form fields, in the order a form would send them. */
  fields: Record<string, string>;
  file: File | Blob;
  filename?: string;
  onProgress?: (fraction: number, loadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function sendMultipart(o: MultipartSend): Promise<{ data: Record<string, unknown>; requestBytes: number }> {
  const { endpoint, fields, file, onProgress, signal, filename } = o;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== "" && value !== undefined && value !== null) body.append(key, value);
    }
    body.append("file", file instanceof File ? file : new File([file], filename ?? "upload", { type: file.type || "application/octet-stream" }));

    const xhr = new XMLHttpRequest();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A request is only ever answered once. Without this, an abort firing after a
    // late 200 would reject a request the caller had already been told about.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      xhr.abort();
      finish(() => reject(new MediaUploadError("Upload cancelled.", { status: 0, code: "ABORTED", retryable: true })));
    };

    xhr.open("POST", endpoint, true);
    xhr.responseType = "text";
    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        onProgress(total > 0 ? Math.min(1, event.loaded / total) : 0, event.loaded, total);
      });
    }
    if (signal) {
      if (signal.aborted) {
        finish(() => reject(new MediaUploadError("Upload cancelled.", { status: 0, code: "ABORTED", retryable: true })));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      xhr.abort();
      finish(() => reject(new MediaUploadError("The upload timed out. The file may be large or the connection slow — try again.", { status: 0, code: "TIMEOUT", retryable: true })));
    }, timeoutMs);

    // The token is read fresh, and only read when a session exists: an
    // unauthenticated upload is refused by the Worker, and sending
    // `Authorization: Bearer null` would turn a clear 401 into a confusing one.
    void readAccessToken()
      .then((token) => {
        if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
        xhr.onload = () => {
          const text = typeof xhr.responseText === "string" ? xhr.responseText : "";
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
          } catch {
            parsed = null;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            finish(() => resolve({ data: (parsed?.["data"] ?? {}) as Record<string, unknown>, requestBytes: file.size }));
            return;
          }
          finish(() => reject(toUploadError(xhr.status, parsed, text)));
        };
        xhr.onerror = () => {
          // `onerror` says nothing about *why*: no response, no status. Reporting it
          // as an outage rather than as a refusal is the difference between a user
          // waiting for the network and a user being told their file is too big.
          finish(() => reject(new MediaUploadError("The upload could not reach the server. Check your connection and try again.", { status: 0, code: "NETWORK", retryable: true })));
        };
        xhr.ontimeout = () => {
          finish(() => reject(new MediaUploadError("The upload timed out.", { status: 0, code: "TIMEOUT", retryable: true })));
        };
        xhr.send(body);
      })
      .catch((err: unknown) => {
        finish(() => reject(new MediaUploadError(err instanceof Error ? err.message : "The session could not be read.", { status: 0, code: "NO_SESSION", retryable: true })));
      });
  });
}

/** Shared field mapping for both results: the Worker answers with the same keys for either endpoint. */
function readAssetFields(data: Record<string, unknown>, file: File | Blob): MediaUploadResult {
  return {
    assetId: Number(data["assetId"] ?? 0),
    url: String(data["url"] ?? ""),
    objectKey: String(data["objectKey"] ?? ""),
    version: Number(data["version"] ?? 1),
    bytes: Number(data["bytes"] ?? file.size),
    contentType: String(data["contentType"] ?? file.type),
    width: typeof data["width"] === "number" ? data["width"] : null,
    height: typeof data["height"] === "number" ? data["height"] : null,
    reused: data["reused"] === true,
  };
}

export function uploadAsset(options: UploadOptions): Promise<MediaUploadResult> {
  const { file, kind, entityId, alt, onProgress, signal, filename } = options;
  return sendMultipart({
    endpoint: mediaUploadEndpoint(),
    fields: { kind, entityId: String(entityId), ...(alt ? { alt } : {}) },
    file,
    filename,
    onProgress,
    signal,
    timeoutMs: options.timeoutMs,
  }).then((sent) => readAssetFields(sent.data, file));
}

/**
 * Phase 8: sponsor artwork.
 *
 * A different endpoint and a different field name (`slot`, not `variant`) because a sponsor's logo is not
 * "another image on an entity" — it is a reserved place in a paid arrangement, and the Worker route that
 * accepts it checks sponsorship rights, per-slot size caps and (in SQL) that the asset belongs to *this*
 * sponsor. The response carries the sponsor row back for the same reason the media route does not need to:
 * the badge on the public page is derived from `logo_url`, so the form can show the new logo the moment the
 * upload resolves instead of waiting for the next band fetch.
 */
export interface SponsorBrandingOptions {
  sponsorId: string;
  slot: "logo" | "banner";
  file: File | Blob;
  alt?: string | null;
  onProgress?: (fraction: number, loadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  filename?: string;
}

export interface SponsorBrandingResult extends MediaUploadResult {
  slot: "logo" | "banner";
  /** The sponsor as the desk sees it, with the new URL already in place — and, like every response in this
   *  system, without a contact field: the public projection is what a page renders. */
  sponsor: Record<string, unknown> | null;
}

export function uploadSponsorBranding(options: SponsorBrandingOptions): Promise<SponsorBrandingResult> {
  const { sponsorId, slot, file, alt, onProgress, signal, filename } = options;
  return sendMultipart({
    endpoint: sponsorBrandingEndpoint(sponsorId),
    fields: { slot, ...(alt ? { alt } : {}) },
    file,
    filename,
    onProgress,
    signal,
    timeoutMs: options.timeoutMs,
  }).then((sent) => ({
    ...readAssetFields(sent.data, file),
    slot,
    sponsor: (sent.data["sponsor"] as Record<string, unknown> | undefined) ?? null,
  }));
}

/** The Worker's envelope is `{ success: false, error: { code, message, fields } }`, and the
 *  media-specific reason rides in `fields[0].message` (the same convention the notification
 *  routes established, so one client-side mapping covers both). */
export function toUploadError(status: number, parsed: Record<string, unknown> | null, rawText: string): MediaUploadError {
  const error = (parsed?.["error"] ?? null) as Record<string, unknown> | null;
  const fields = (error?.["fields"] ?? null) as { field?: string; message?: string }[] | null;
  const reason = fields && fields.length > 0 ? String(fields[0]?.message ?? "") : "";
  const message = typeof error?.["message"] === "string" && error["message"] !== "" ? error["message"] : null;
  const code = typeof error?.["code"] === "string" ? error["code"] : `HTTP_${String(status)}`;
  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  if (message) return new MediaUploadError(message, { status, code, reason: reason || null, retryable });
  if (rawText.trim().startsWith("<"))
    return new MediaUploadError("The server answered with something that was not the API. It is usually a proxy or a login page; try again in a moment.", { status, code, retryable: true });
  return new MediaUploadError(`The upload was refused (HTTP ${String(status)}).`, { status, code, reason: reason || null, retryable });
}
