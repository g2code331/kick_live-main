#  KICKLIVE - QUICK DEPLOYMENT CHECKLIST

## ✅ PRE-DEPLOYMENT (Already Done!)
- [x] Code is ready
- [x] .env file configured
- [x] vercel.json created
- [x] Build successful

---

##  STEP 1: GITHUB (2 minutes)

- [ ] Go to GitHub.com
- [ ] Login with your account
- [ ] Click "+" → "New repository"
- [ ] Name: **kicklive**
- [ ] Click "Create repository"
- [ ] Click "uploading an existing file"
- [ ] Upload ALL project files
- [ ] Click "Commit changes"

**✅ DONE when you see your code on GitHub**

---

## 🚀 STEP 2: VERCEL (2 minutes)

- [ ] Go to Vercel.com
- [ ] Login with GitHub
- [ ] Click "Add New..." → "Project"
- [ ] Find "kicklive" repository
- [ ] Click "Import"
- [ ] Click "Environment Variables"
- [ ] Add VITE_SUPABASE_URL (see below)
- [ ] Add VITE_SUPABASE_ANON_KEY (see below)
- [ ] Click "Deploy"
- [ ] Wait for build to complete

**Environment Variables:**

```
VITE_SUPABASE_URL = https://fnefpcjeebawsebxjhcf.supabase.co

VITE_SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuZWZwY2plZWJhd3NlYnhqaGNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNDAyMTQsImV4cCI6MjA5OTYxNjIxNH0.YkPu5IxtEPZHK9i0oiMTRROrwCT3ZdF1RgCEhaqDhwo
```

**✅ DONE when you see "🎉 Congratulations!"**

---

## 🗄️ STEP 3: SUPABASE SQL (1 minute)

- [ ] Go to supabase.com/dashboard
- [ ] Open project: fnefpcjeebawsebxjhcf
- [ ] Click "SQL Editor"
- [ ] Click "New Query"
- [ ] Open SUPABASE_NEW_PROJECT_SETUP.sql file
- [ ] Copy ALL content
- [ ] Paste in SQL Editor
- [ ] Click "Run"
- [ ] Wait for success message

**✅ DONE when you see "Success. No rows returned"**

---

## 🧪 STEP 4: TEST (2 minutes)

- [ ] Copy your Vercel URL (e.g., kicklive-xxx.vercel.app)
- [ ] Open in **Incognito mode** (Ctrl+Shift+N)
- [ ] Open Console (F12)
- [ ] Look for: `[DataLoader] ✓ Data refreshed:`
- [ ] Should show: `{teams: 0, players: 0, competitions: 0, matches: 0}`
- [ ] Click "Sign Up"
- [ ] Use a NEW email (not used before)
- [ ] Complete signup
- [ ] Login with new account
- [ ] Go to Match Control
- [ ] Click CONTROL MATCH
- [ ] Click KICK OFF
- [ ] Watch timer run
- [ ] **Refresh page** - Timer should continue!

**✅ DONE when timer persists after refresh!**

---

## 🎉 SUCCESS CRITERIA

Your deployment is successful when:

1. ✅ Vercel shows green checkmark
2. ✅ App loads without errors
3. ✅ Can sign up with new account
4. ✅ Console shows empty database (0 teams, 0 matches)
5. ✅ Timer runs and persists on refresh
6. ✅ Supabase usage shows ~0 MB egress

---

## ❌ TROUBLESHOOTING

**Problem:** Old data still shows
- **Solution:** Redeploy on Vercel (Settings → Deployments → Redeploy)

**Problem:** Build fails
- **Solution:** Check build logs, usually missing env variables

**Problem:** Timer resets on refresh
- **Solution:** Verify SQL was run in NEW Supabase project

**Problem:** Cannot login
- **Solution:** Clear browser cache, try incognito mode

---

## 📞 NEED HELP?

Tell me:
1. Which step are you on?
2. What do you see on screen?
3. Any error messages?

I'll guide you through!

---

**Estimated Total Time: 7 minutes** ⏱️
