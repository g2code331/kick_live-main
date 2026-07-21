import { useState } from 'react';
import { X, Newspaper, Upload, Save, Loader2, Image as ImageIcon, Link as LinkIcon, FileText } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MediaPublisherProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MediaPublisher({ isOpen, onClose }: MediaPublisherProps) {
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    category: 'News',
    image_url: '',
    content: '',
    excerpt: ''
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Image must be under 5MB.');
      return;
    }

    setUploadError(null);
    setUploading(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `articles/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from('media').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
      });
      if (uploadErr) throw uploadErr;

      const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(path);
      setFormData(prev => ({ ...prev, image_url: publicUrlData.publicUrl }));
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.image_url) {
      setUploadError('Please upload an image or paste an image URL before publishing.');
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.from('media').insert([{
        title: formData.title,
        category: formData.category,
        image_url: formData.image_url,
        content: formData.content,
        excerpt: formData.excerpt,
        created_at: new Date().toISOString()
      }]);

      if (error) throw error;
      alert('Article published successfully!');
      onClose();
    } catch (err: any) {
      alert('Error publishing: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose}></div>
      <div className="relative w-full max-w-2xl glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300 max-h-[90vh] flex flex-col">
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-purple-500/10 to-transparent">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-purple-500 rounded-xl flex items-center justify-center">
               <Newspaper className="text-white" size={20} />
             </div>
             <div>
               <h2 className="text-xl font-black italic uppercase tracking-tighter">Publish <span className="text-purple-500">Content</span></h2>
               <p className="text-[10px] text-white/40 uppercase font-black tracking-widest">Media Distribution</p>
             </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto no-scrollbar">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Article Title</label>
            <input
              type="text"
              required
              value={formData.title}
              onChange={e => setFormData({...formData, title: e.target.value})}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50 transition-colors"
              placeholder="e.g. Breakout Season for Volta Rangers"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Category</label>
              <select
                value={formData.category}
                onChange={e => setFormData({...formData, category: e.target.value})}
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
              <label className="flex items-center justify-center gap-2 w-full bg-white/5 border border-dashed border-white/20 rounded-xl p-3 text-xs text-white/40 cursor-pointer hover:border-purple-500/50 hover:text-white/60 transition-colors">
                {uploading ? (
                  <><Loader2 size={14} className="animate-spin" /> Uploading…</>
                ) : (
                  <><Upload size={14} /> {formData.image_url ? 'Change image' : 'Upload image'}</>
                )}
                <input type="file" accept="image/*" onChange={handleFileSelect} className="hidden" disabled={uploading} />
              </label>
            </div>
          </div>

          {formData.image_url && (
            <div className="rounded-xl overflow-hidden border border-white/10 h-32">
              <img src={formData.image_url} alt="Preview" className="w-full h-full object-cover" />
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
                onChange={e => { setFormData({...formData, image_url: e.target.value}); setUploadError(null); }}
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-purple-500/50"
                placeholder="https://..."
              />
            </div>
          </div>

          {uploadError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2.5 rounded-xl text-xs font-bold">
              {uploadError}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Short Excerpt</label>
            <textarea
              rows={2}
              required
              value={formData.excerpt}
              onChange={e => setFormData({...formData, excerpt: e.target.value})}
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
              onChange={e => setFormData({...formData, content: e.target.value})}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500/50"
              placeholder="Write your story here..."
            />
          </div>

          <div className="pt-4 mt-auto">
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-500 text-white font-black uppercase tracking-widest py-4 rounded-xl flex items-center justify-center gap-2 hover:bg-purple-600 transition-colors disabled:opacity-50 shadow-[0_0_30px_rgba(168,85,247,0.3)]"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <><Upload size={18} /> Publish Article</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}