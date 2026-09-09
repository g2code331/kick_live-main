import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

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

stampDocumentIdentity();
registerServiceWorker();
console.info(`[kicklive] boot shell=${SHELL} version=${APP_VERSION}`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
