# 🚀 Deploy KickLive to Vercel

## Quick Deploy (Recommended)

### Option 1: Deploy via Vercel Dashboard
1. Go to [vercel.com](https://vercel.com)
2. Click **"Add New Project"**
3. Import your GitHub repository
4. Vercel will auto-detect Vite settings
5. Click **"Deploy"**

### Option 2: Deploy via CLI
```bash
# Install Vercel CLI
npm i -g vercel

# Login to Vercel
vercel login

# Deploy
vercel
```

## Environment Variables

If you have any environment variables:
1. Go to your project on Vercel
2. Navigate to **Settings** → **Environment Variables**
3. Add your Supabase credentials:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

## Post-Deployment

After deployment:
1. Your app will be live at `https://your-project.vercel.app`
2. You can connect a custom domain in Vercel settings
3. Automatic deployments on every push to `main` branch

## Troubleshooting

### Build Fails
- Check that `npm run build` works locally
- Ensure all TypeScript errors are fixed
- Check Vercel build logs for specific errors

### Database Connection Issues
- Verify Supabase URL and Anon Key are correct
- Check that RLS policies allow public reads
- Ensure your Supabase project is not paused

## Custom Domain

To add a custom domain:
1. Go to **Project Settings** → **Domains**
2. Add your domain (e.g., `kicklive.com`)
3. Follow DNS configuration instructions
4. SSL certificate is auto-generated

---

**Your KickLive app is now ready for production!** 🏆
