# Push to GitHub — 2 minutes

This folder is already a git repo with one clean commit (no secrets).

## Option A: GitHub website (no CLI)

1. Go to https://github.com/new
2. Repository name: `statom-v4`
3. Visibility: **Public** (required — private counts as no submission)
4. Do NOT check "Add a README" — leave empty
5. Click **Create repository**
6. On the next page, copy the HTTPS URL (e.g. `https://github.com/YOURNAME/statom-v4.git`)
7. In this folder, run:

```bash
git remote add origin https://github.com/YOURNAME/statom-v4.git
git push -u origin main
```

When prompted, use a Personal Access Token (Settings → Developer settings → Tokens → Generate new token classic → repo scope).

8. Verify: open `https://github.com/YOURNAME/statom-v4` in incognito — it should load without login.

## Option B: GitHub CLI

```bash
gh auth login
gh repo create statom-v4 --public --source=. --remote=origin --push
```

## After pushing

- Add your video link and live demo URL to `README.md`
- Edit `package.json` → `repository.url` to your real URL
- Add team names to README Team section
- Final check: `git log --oneline` and `git status` clean

## If you accidentally pushed the old zip with hardcoded key

1. Rotate the Groq key at https://console.groq.com/keys → Delete old `gsk_SnZJWs...`
2. Push this clean repo (it uses `VITE_GROQ_API_KEY` via `.env`, no key in code)

