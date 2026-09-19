import { useRef, useState } from 'react';
import { Camera, Loader2, Upload, AlertCircle } from 'lucide-react';
import { uploadAsset, isMediaUploadError, type MediaUploadKind } from '../lib/media/upload';
import { assetUrl } from '../lib/media/assets';

/**
 * A single-image picker for an entity slot (a team crest, a player photo, …). It shows the current image
 * (or an initials/placeholder), lets the user pick a file, uploads it through the Worker media pipeline
 * (sniff → reserve → write → publish), and hands the resulting render URL back via `onUploaded` so the
 * parent can persist it on its row and update its preview.
 *
 * It is deliberately dumb about persistence: the Worker writes the asset and returns the URL; whether that
 * URL also gets written to `teams.logo_url` / `players.photo_url` is the caller's decision (some callers do
 * it in the same save, some immediately). The upload requires a signed-in session and a reachable `/api`.
 */
export default function EntityImageUploader({
  kind,
  entityId,
  currentUrl,
  label = 'Photo',
  placeholder,
  shape = 'circle',
  size = 96,
  onUploaded,
  onError,
}: {
  kind: MediaUploadKind;
  entityId: string | number | null | undefined;
  currentUrl?: string | null;
  label?: string;
  /** Initials or a glyph shown when there is no image yet. */
  placeholder?: React.ReactNode;
  shape?: 'circle' | 'square';
  size?: number;
  onUploaded: (url: string) => void;
  onError?: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const shown = preview || assetUrl(currentUrl) || (typeof currentUrl === 'string' && currentUrl ? currentUrl : null);
  const rounded = shape === 'circle' ? 'rounded-full' : 'rounded-2xl';

  const pick = () => {
    if (busy) return;
    if (entityId === null || entityId === undefined || entityId === '') {
      const m = 'Save the record first, then add an image.';
      setLocalError(m);
      onError?.(m);
      return;
    }
    inputRef.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || entityId === null || entityId === undefined) return;
    setBusy(true);
    setLocalError(null);
    setProgress(0);
    // Optimistic local preview while the bytes travel.
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    try {
      const result = await uploadAsset({
        file,
        kind,
        entityId,
        onProgress: (f) => setProgress(Math.round(f * 100)),
      });
      onUploaded(result.url);
      // Swap the blob preview for the durable URL once known.
      setPreview(assetUrl(result.url) ?? result.url);
    } catch (err) {
      const message = isMediaUploadError(err) ? err.message : 'Upload failed. Please try again.';
      setLocalError(message);
      onError?.(message);
      setPreview(null);
    } finally {
      URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={pick}
        className={`relative shrink-0 overflow-hidden border border-white/10 bg-white/5 flex items-center justify-center group ${rounded}`}
        style={{ width: size, height: size }}
        aria-label={`Upload ${label.toLowerCase()}`}
      >
        {shown ? (
          <img src={shown} alt={label} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/30 text-2xl font-black">{placeholder ?? <Camera size={size * 0.35} />}</span>
        )}
        <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          {busy ? <Loader2 size={20} className="animate-spin text-white" /> : <Camera size={20} className="text-white" />}
        </span>
        {busy && progress > 0 && progress < 100 && (
          <span className="absolute bottom-0 left-0 h-1 bg-brand-green transition-all" style={{ width: `${String(progress)}%` }} />
        )}
      </button>
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-1">{label}</p>
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {busy ? `Uploading ${String(progress)}%` : shown ? 'Change' : 'Upload'}
        </button>
        {localError && (
          <p className="mt-1.5 flex items-center gap-1 text-[10px] text-red-400 font-bold">
            <AlertCircle size={11} /> {localError}
          </p>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}
