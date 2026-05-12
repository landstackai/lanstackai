# Landstack AI — Deployment Guide

## What You Have
A complete Next.js application with:
- Comp vault with quick capture, full form, PDF import
- AI chat import (paste from email, upload PDF)  
- Interactive map with Mapbox
- CMA builder with shareable client report
- AI property description generator
- Supabase database with Row Level Security

---

## STEP 1: Set Up Supabase Database

1. Go to **supabase.com** → your `landstack-ai` project
2. Click **SQL Editor** in the left sidebar
3. Click **New query**
4. Open the file `supabase/migrations/001_initial_schema.sql`
5. Copy ALL the SQL content
6. Paste it into the SQL editor
7. Click **Run**

You should see: "Success. No rows returned"

---

## STEP 2: Upload Code to GitHub

### Option A — GitHub Desktop (Easiest)
1. Download GitHub Desktop: desktop.github.com
2. Sign in with your GitHub account (landstackai)
3. Click "Add Existing Repository"
4. Navigate to this folder
5. Click "Publish repository"
6. Name: `landstack-ai`
7. Make sure "Keep this private" is checked
8. Click "Publish"

### Option B — Command Line
Open Terminal/Command Prompt in this folder:
```bash
git init
git add .
git commit -m "Initial Landstack AI build"
git branch -M main
git remote add origin https://github.com/landstackai/landstack-ai.git
git push -u origin main
```

---

## STEP 3: Deploy to Vercel

1. Go to **vercel.com** → you're already signed in
2. Click **"Add New Project"**
3. Click **"Import Git Repository"**
4. Click **"Continue with GitHub"**
5. Find `landstack-ai` in the list
6. Click **Import**

### Add Environment Variables
Before clicking Deploy, click **"Environment Variables"** and add these one by one. Get the actual values from your Supabase / Mapbox / OpenAI dashboards — never commit them to git.

```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-project-url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your-supabase-publishable-key>
SUPABASE_SECRET_KEY=<your-supabase-service-role-key>
NEXT_PUBLIC_MAPBOX_TOKEN=<your-mapbox-public-token>
OPENAI_API_KEY=<your-openai-api-key>
```

See `.env.local.example` for the full list.

7. Click **Deploy**
8. Wait 2-3 minutes for the build

---

## STEP 4: Connect Your Domain

1. In Vercel → your project → Settings → Domains
2. Click "Add Domain"
3. Type: `landstack.ai`
4. Follow the DNS instructions shown
5. Go to your domain registrar (where you bought landstack.ai)
6. Add the DNS records Vercel shows you
7. Wait 10-30 minutes for DNS to propagate

---

## STEP 5: Set Up Supabase Auth Redirect URLs

1. Go to Supabase → your project
2. Authentication → URL Configuration
3. Add to "Redirect URLs":
   - `https://landstack.ai/auth/callback`
   - `https://landstack-ai.vercel.app/auth/callback`
4. Set "Site URL" to: `https://landstack.ai`

---

## STEP 6: Create Your First Account

1. Go to your live URL
2. Click "Sign up"
3. Create your account
4. Start adding comps!

---

## What's Built

| Screen | What It Does |
|--------|-------------|
| `/auth/login` | Sign in page |
| `/auth/signup` | Create account (14-day trial) |
| `/dashboard/vault` | Comp vault — view, filter, add, edit |
| `/dashboard/map` | Interactive Mapbox map with comp pins |
| `/dashboard/cma` | CMA builder with shareable client link |
| `/dashboard/import` | AI chat — paste PDF text or upload |
| `/report/[token]` | Client-facing interactive report |

---

## Quick Capture (Mobile)

On your phone:
1. Open the app
2. Tap the **+** button
3. Enter County, Acres, Price (15 seconds)
4. Done — comp saved as draft

---

## PDF Import (Mobile)

On your phone:
1. Open an email with an appraisal PDF
2. Tap and hold the PDF → Copy
3. Open Landstack AI → Import tab
4. Paste in the chat box
5. AI reads it and extracts comps
6. Tap "Add to Vault"

---

## Support

For issues or feature requests, continue the conversation at Claude.ai with the full session transcript.

---

*Built with Next.js 14 · Supabase · Mapbox · OpenAI GPT-4o*
*landstack.ai — The intelligence layer for land.*
