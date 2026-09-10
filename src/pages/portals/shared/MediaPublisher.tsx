import { useEffect, useRef, useState } from "react";
import { X, Newspaper, Upload, Loader2, Image as ImageIcon, Link as LinkIcon, RefreshCw } from "lucide-react";
import { supabase } from "../../../lib/supabase";
import { assetUrl } from "../../../lib/media/assets";
import { uploadAsset, isMediaUploadError } from "../../../lib/media/upload";

interface MediaPublisherProps {
  isOpen: boolean;
  onClose: () => void;
}

/** The `news` category cap in workers/src/lib/mediaPolicy.ts, restated here so the
 *  form can refuse a 40 MB file before it costs a user the upload. The Worker
 *  refuses it again — a client-side limit is a courtesy, not a control, and the two
 *  numbers being equal is asserted in tests/unit/phase6-media.test.ts. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type UploadPhase = "idle" | "publishing" | "uploading" | "cancelling";

export default function MediaPublisher({ isOpen, onClose }: MediaPublisherProps) {
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [staged, setStaged] = useState<{ file: File; preview: string } | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    category: "News",
    image_url: "",
    content: "",
    excerpt: "",
  });
  // The article the image belongs to. Kept in a ref because a retry must not
  // create a second article: after the insert succeeds, every later attempt is an
  // upload and nothing else.
  const articleIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase !== "idle";
  // One expression for both cases: a staged file shows its object URL, an existing or
  // pasted URL is resolved by `assetUrl` (which is what makes a stored
  // `/api/media/assets/...` path load from the right host).
  const previewSrc = staged ? staged.preview : (assetUrl(formData.image_url) ?? "");

  // An object URL is a leak if nothing revokes it, and "close the modal" is exactly
  // when nobody is watching any more.
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      abortRef.current = null;
      setProgress(0);
      setPhase("idle");
      setCanRetry(false);
    }
    return () => {
      if (!isOpen && staged) URL.revokeObjectURL(staged.preview);
    };
    // `staged` is read only to release its URL on close; re-running on every
    // preview change would revoke a URL the preview is still using.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(
    () => () => {
      if (staged) URL.revokeObjectURL(staged.preview);
      abortRef.current?.abort();
    },
    [staged],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setUploadError("Please choose a PNG, JPEG, WebP or GIF image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit for an article image is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploadError(null);
    setCanRetry(false);
    setStaged((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return { file, preview: URL.createObjectURL(file) };
    });
  };

  const storeStagedImage = async (entityId: number) => {
    if (!staged) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("uploading");
    setProgress(0);
    try {
      const result = await uploadAsset({
        file: staged.file,
        kind: "news",
        entityId,
        alt: formData.title.slice(0, 300),
        signal: controller.signal,
        onProgress: (fraction) => setProgress(Math.round(fraction * 100)),
      });
      // The Worker attached the URL to the article row in the same call that
      // published it, so there is nothing for this form to write back.
      setFormData((prev) => ({ ...prev, image_url: result.url }));
      setCanRetry(false);
    } catch (err) {
      const message = isMediaUploadError(err) ? err.message : "The image could not be stored.";
      const retryable = isMediaUploadError(err) && err.retryable;
      setUploadError(message);
      setCanRetry(retryable);
      // Deliberately not fatal: the article is published and its image is not. That
      // is a half-finished task, not a failed one, and the retry below finishes it.
    } finally {
      abortRef.current = null;
      setPhase("idle");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staged && !formData.image_url) {
      setUploadError("Please choose an image or paste an image URL before publishing.");
      return;
    }
    setUploadError(null);
    setPhase("publishing");
    try {
      // The article is saved first and its image second, because the media registry
      // files every object under an entity that exists. The older order — upload,
      // then hope the insert follows — left an orphan in the bucket for every
      // publisher that closed the tab mid-way.
      const { data, error } = await supabase
        .from("media")
        .insert([
          {
            title: formData.title,
            category: formData.category,
            // An external paste is stored verbatim; a staged file is attached by the
            // Worker once the row exists, so the column is left to it.
            image_url: staged ? null : formData.image_url,
            content: formData.content,
            excerpt: formData.excerpt,
            created_at: new Date().toISOString(),
          },
        ])
        .select("id")
        .single();

      if (error) throw error;
      const id = Number((data as { id?: number } | null)?.id ?? 0);
      onClose();

      if (staged && id > 0) {
        articleIdRef.current = id;
        await storeStagedImage(id);
      }
    } catch (err: any) {
      setPhase("idle");
      alert("Error publishing: " + (err?.message ?? "unknown error"));
    }
  };

  const handleCancelUpload = () => {
    setPhase("cancelling");
    abortRef.current?.abort();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={busy ? undefined : onClose}></div>
      <div className="relative w-full max-w-2xl glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300 max-h-[90vh] flex flex-col">
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-purple-500/10 to-transparent">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-500 rounded-xl flex items-center justify-center">
              <Newspaper className="text-white" size={20} />
            </div>
            <div>
              <h2 className="text-xl font-black italic uppercase tracking-tighter">
                Publish <span className="text-purple-500">Content</span>
              </h2>
              <p className="text-[10px] text-white/40 uppercase font-black tracking-widest">Media Distribution</p>
            </div>
          </div>
          {/* One button, two meanings while a request is in flight: it stops the upload
              rather than walking away from it mid-byte. */}
          <button onClick={busy ? handleCancelUpload : onClose} title={busy ? "Cancel the upload in progress" : "Close"} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto no-scrollbar">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Article Title</label>
            <input
              type="text"
              required
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50 transition-colors"
              placeholder="e.g. Breakout Season for Volta Rangers"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Category</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50"
              >
                <option>News</option>
                <option>Match Report</option>
                <option>Interview</option>
                <option>Announcement</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Featured Image</label>
              <label
                className={`flex items-center justify-center gap-2 w-full bg-white/5 border border-dashed border-white/20 rounded-xl p-3 text-xs text-white/40 transition-colors ${busy ? "cursor-wait" : "cursor-pointer hover:border-purple-500/50 hover:text-white/60"}`}
              >
                {busy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> {phase === "uploading" ? `${progress}%` : "Working…"}
                  </>
                ) : (
                  <>
                    <Upload size={14} /> {staged || formData.image_url ? "Change image" : "Upload image"}
                  </>
                )}
                <input type="file" accept={ACCEPTED.join(",")} onChange={handleFileSelect} className="hidden" disabled={busy} />
              </label>
            </div>
          </div>

          {previewSrc && (
            <div className="rounded-xl overflow-hidden border border-white/10 h-32">
              <img src={previewSrc} alt="Preview" className="w-full h-full object-cover" />
            </div>
          )}

          {staged && (
            <p className="text-[10px] text-white/40 uppercase font-black tracking-widest">
              Stored when the article is saved · {ACCEPTED.includes(staged.file.type) ? staged.file.type.replace("image/", "").toUpperCase() : "image"} · {(staged.file.size / 1024).toFixed(0)} KB
            </p>
          )}

          {phase === "uploading" && (
            <div className="h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-purple-500 transition-[width] duration-200" style={{ width: `${progress}%` }} />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
              <LinkIcon size={11} /> Or paste an image URL instead
            </label>
            <div className="relative">
              <ImageIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
              <input
                type="url"
                value={formData.image_url}
                onChange={(e) => {
                  setFormData({ ...formData, image_url: e.target.value });
                  setUploadError(null);
                  setStaged(null);
                }}
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-purple-500/50"
                placeholder="https://..."
              />
            </div>
          </div>

          {uploadError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2.5 rounded-xl text-xs font-bold flex items-start justify-between gap-3">
              <span>{uploadError}</span>
              {canRetry && articleIdRef.current ? (
                <button
                  type="button"
                  onClick={() => {
                    setUploadError(null);
                    void storeStagedImage(articleIdRef.current as number);
                  }}
                  className="shrink-0 inline-flex items-center gap-1 text-white/70 hover:text-white uppercase tracking-widest text-[10px] font-black"
                >
                  <RefreshCw size={12} /> Retry
                </button>
              ) : null}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Short Excerpt</label>
            <textarea
              rows={2}
              required
              value={formData.excerpt}
              onChange={(e) => setFormData({ ...formData, excerpt: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50 resize-none"
              placeholder="A brief summary for the feed..."
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Full Article Content</label>
            <textarea
              rows={6}
              required
              value={formData.content}
              onChange={(e) => setFormData({ ...formData, content: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50"
              placeholder="Write your story here..."
            />
          </div>

          <div className="pt-4 mt-auto flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 bg-purple-500 text-white font-black uppercase tracking-widest py-4 rounded-xl flex items-center justify-center gap-2 hover:bg-purple-600 transition-colors disabled:opacity-50 shadow-[0_0_30px_rgba(168,85,247,0.3)]"
            >
              {busy ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  <Upload size={18} /> Publish Article
                </>
              )}
            </button>
            {phase === "uploading" && (
              <button
                type="button"
                onClick={handleCancelUpload}
                className="px-4 py-4 rounded-xl border border-white/10 text-white/60 hover:text-white hover:bg-white/10 font-black uppercase tracking-widest text-[10px] inline-flex items-center gap-2"
              >
                <X size={14} /> Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
