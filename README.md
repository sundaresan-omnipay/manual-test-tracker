# Manual Test Tracker

A free, deployable web app for tracking cannot-be-automated manual test cases per release, connected to your GitHub CSV.

---

## Local Setup

```bash
npm install
npm run dev
```

Open http://localhost:5174

---

## Deploy to Vercel (Free — share with team)

### One-time setup:

1. Push this folder to a GitHub repo
2. Go to https://vercel.com → Sign in with GitHub (free)
3. Click **Add New Project** → Import your repo
4. Leave all settings as default → Click **Deploy**
5. Vercel gives you a public URL like `https://manual-test-tracker.vercel.app`
6. Share this URL with your team ✅

Every time you push to main, Vercel auto-redeploys.

---

## GitHub CSV Format

Your CSV in GitHub must have these columns (header names are flexible):

```csv
id,title,category,description
TC-001,Successful card payment,Payments,Test Visa card end-to-end flow
TC-002,3DS challenge flow,Payments,Test 3DS redirect and return handling
TC-003,Split payment reseller,Resellers,Verify commission split is correct
TC-004,Refund partial amount,Refunds,Partially refund a completed transaction
```

---

## How to Use

1. **Settings** → Paste your GitHub repo URL + CSV file path → Save
2. **New Release** → Enter release name + Jira ticket number + URL
3. **Pick Test Cases** tab → Check which test cases apply to this release
4. **Run Tests** tab → Mark each as Pass / Fail / Skip + add notes
5. **Export CSV** → Download results to share or attach to Jira

---

## Data Storage

All release data and results are saved in **localStorage** — no backend, no database, no costs.
Each team member's browser stores their own data independently.

---

## Tech Stack

- React 18 + Vite
- PapaParse (CSV parsing)
- Lucide React (icons)
- Deployed free on Vercel
