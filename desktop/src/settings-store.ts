/**
 * JSON settings store in userData, and the UpdateStorage adapter the shared controller wants.
 *
 * Written by hand (no electron-store dependency): a settings file that a user must be able to
 * `cat` when an update decision looks wrong. Atomic replace + corrupt-file recovery are the two
 * things a hand-rolled store usually forgets, so they are the two things tested here.
 */

import fs from "node:fs";
import path from "node:path";

import type { Channel } from "../../shared/update-manifest.ts";
import type { UpdateStore, UpdateStorage } from "../../shared/update-controller.ts";

export type Settings = {
  schemaVersion: 1;
  updates: UpdateStore;
  autoCheck: boolean;
  channel: Channel;
};

export function defaultSettings(channel: Channel = "stable"): Settings {
  return {
    schemaVersion: 1,
    autoCheck: true,
    channel,
    updates: { schemaVersion: 1, lastSeen: null, lastCheckAt: null, lastOutcome: null, snoozedUntil: {} },
  };
}

function isSafeSegment(v: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(v) && !v.includes("..");
}

/** Only string -> ISO-string entries survive; anything else would crash the controller's Date.parse. */
function sanitizeSnooze(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) out[key] = new Date(value).toISOString();
  }
  return out;
}

export class SettingsFile {
  readonly file: string;
  private cache: Settings | null = null;

  constructor(dir: string, name = "settings.json") {
    if (!isSafeSegment(name)) throw new Error(`unsafe settings file name: ${name}`);
    this.file = path.join(dir, name);
  }

  read(): Settings {
    if (this.cache) return this.cache;
    let settings = defaultSettings();
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (parsed && typeof parsed === "object") {
        const base = defaultSettings(parsed.channel === "beta" ? "beta" : "stable");
        settings = {
          ...base,
          ...parsed,
          schemaVersion: 1,
          channel: parsed.channel === "beta" ? "beta" : "stable",
          autoCheck: parsed.autoCheck !== false,
          updates: {
            ...base.updates,
            ...(parsed.updates ?? {}),
            snoozedUntil: sanitizeSnooze(parsed.updates?.snoozedUntil),
          },
        };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Corrupt (or unreadable): keep the evidence, start from defaults.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${String(Date.now())}`);
        } catch {
          /* ignore */
        }
      }
    }
    this.cache = settings;
    return settings;
  }

  write(next: Settings): void {
    this.cache = next;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(patch: (current: Settings) => Settings): Settings {
    const next = patch(this.read());
    this.write(next);
    return next;
  }

  forgetCache(): void {
    this.cache = null;
  }
}

export function createSettingsStorage(file: SettingsFile): UpdateStorage {
  return {
    async load() {
      return file.read().updates;
    },
    async save(updates) {
      file.update((current) => ({ ...current, updates }));
    },
  };
}

export function createMemoryStorage(initial?: Partial<UpdateStore>): UpdateStorage & { current: () => UpdateStore } {
  let store: UpdateStore = { ...defaultSettings().updates, ...initial };
  return {
    current: () => store,
    async load() {
      return store;
    },
    async save(next: UpdateStore) {
      store = { ...next, snoozedUntil: { ...next.snoozedUntil } };
    },
  };
}
