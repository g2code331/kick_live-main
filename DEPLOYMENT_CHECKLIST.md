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

VITE_SUPABASE_ANON_KEY = <paste the publishable/anon key from Supabase → Settings → API>
# The key is public by design (RLS enforces access), but it is still project-specific: pasting
# one from a guide instead of your project was how this repo ended up with a URL and a key for
# two different projects. Neither value is committed to git any more — see .env.example.
```

**✅ DONE when you see "🎉 Congratulations!"**

---

## 🗄️ STEP 3: SUPABASE SQL (1 minute)

- [ ] Go to supabase.com/dashboard
- [ ] Open project: fnefpcjeebawsebxjhcf
- [ ] Click "SQL Editor" → "New Query"
- [ ] Run `KICKLIVE_FINAL_SCHEMA.sql` (the authoritative base schema; idempotent)
- [ ] Then run the files in `supabase/migrations/` **in filename order** — the timestamps are the apply order:
      `20260909120000_phase1_security_hardening`,
      `20260909210000_phase3_live_match_engine`,
      `20260910120000_phase4_read_aggregates`,
      `20260911120000_phase5_notifications`,
      `20260912120000_phase6_r2_media`,
      `20260913120000_phase7_advertising`,
      `20260914120000_phase8_sponsorship`,
      `20260915120000_phase9_observability`,
      `20260916120000_phase10_privilege_tightening`
- [ ] Click "Run" after each one, and stop at the first error

**Do not paste `SUPABASE_NEW_PROJECT_SETUP.sql`, `SUPABASE_COMPLETE_SCHEMA.sql` or `supabase_migrations.sql`.**
They are kept for reference, each carries a "SUPERSEDED — DO NOT RUN" banner, and running one on a hardened
project *re-opens* the privilege-escalation hole Phase 1 closed: an `UPDATE` policy with a `USING` clause and
no `WITH CHECK` lets any signed-in account rewrite its own `profiles.role`. If a step in a document says
otherwise, the step is the bug — `supabase/README.md` is the index of what is authoritative. With the CLI the
same nine steps are `supabase db push`.

**✅ DONE when the last file answers "Success. No rows returned" and this lists the public read policies:**

```sql
select tablename, policyname from pg_policies
 where schemaname = 'public' and policyname like '%public read%' order by 1;
```

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
