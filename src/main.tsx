import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

import { APP_VERSION, SHELL } from "./lib/app-shell.ts";

/**
 * Stamp the build identity into the document before rendering.
 *
 * The desktop smoke test asserts `document.title` plus this pair, which is what makes "the right
 * bundle actually booted" provable from outside the window.
 */
function stampDocumentIdentity(): void {
  const set = (name: string, content: string): void => {
    const el = document.head.querySelector(`meta[name="${name}"]`);
    if (el) el.setAttribute("content", content);
  };
  set("kicklive:version", APP_VERSION);
  set("kicklive:shell", SHELL);
  document.documentElement.dataset.kickliveShell = SHELL;
  document.documentElement.dataset.kickliveVersion = APP_VERSION;
}

function registerServiceWorker(): void {
  // Desktop (file://) has no SW by design; dev builds skip it so HMR stays honest.
  if (!import.meta.env.PROD) return;
  if (SHELL !== "web") return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!location.protocol.startsWith("http")) return;
  window.addEventListener("load", () => {
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url, { scope: "/" }).catch((err: unknown) => {
      console.warn(`[kicklive] service worker registration failed: ${String(err)}`);
    });
  });
}

/**
 * A deploy with no Supabase config used to boot happily against a hardcoded project baked into the
 * bundle (and the URL and the key that were baked in did not even belong to the same project). It
 * now refuses to start — but a red console is a bad experience for a first-time operator, so we say
 * what is missing in the page itself. `App` is imported lazily because importing it pulls in
 * `src/lib/supabase.ts`, which throws on a missing config by design.
 */
function renderBootFailure(reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild.";
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.setAttribute("data-kicklive-boot", "config-error");
  box.style.cssText =
    "max-width:38rem;margin:14vh auto;padding:2rem;font:500 14px/1.6 ui-sans-serif,system-ui,sans-serif;color:#e6f7ec;background:#0b0e13;border:1px solid rgba(255,255,255,.08);border-radius:1rem";
  const h1 = document.createElement("h1");
  h1.textContent = "KickLive is not configured";
  h1.style.cssText = "font-size:1.25rem;margin:0 0 .75rem;letter-spacing:-.01em";
  const pre = document.createElement("pre");
  pre.textContent = detail;
  pre.style.cssText = "white-space:pre-wrap;margin:0;color:#9fb3a8;font-family:inherit";
  const hint = document.createElement("p");
  hint.textContent = "Copy .env.example to .env.local (or set the variables in your host) and rebuild.";
  hint.style.cssText = "margin:1rem 0 0;color:#6f8579;font-size:12px";
  box.append(h1, pre, hint);
  root.append(box);
}

async function boot(): Promise<void> {
  const { isSupabaseConfigured } = await import("./lib/env");
  if (!isSupabaseConfigured()) {
    renderBootFailure("Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY.\nNo default backend is compiled into the app.");
    return;
  }

  try {
    const { default: App } = await import("./App");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    // Anything thrown while resolving the client config lands here instead of a blank window.
    renderBootFailure(err);
    console.error("[kicklive] boot aborted:", err instanceof Error ? err.message : err);
  }
}

stampDocumentIdentity();
registerServiceWorker();
console.info(`[kicklive] boot shell=${SHELL} version=${APP_VERSION}`);
void boot();
