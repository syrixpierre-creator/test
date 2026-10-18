# Render

Files: `render.yaml` (web service, Docker runtime, `/api/health` health check, 30 GB persistent disk at `/data`, `autoDeploy: false`).

Not tested. Check Render's current plans before relying on this.

1. Publish the repository, then create a Blueprint from it in the Render dashboard. Render reads `render.yaml`.
2. Enter the values it asks for: `PUBLIC_BASE_URL` (the `https://...onrender.com` or custom address), `ALLOWED_ORIGINS` (empty unless the frontend is hosted elsewhere) and `API_KEY` (optional).
3. Persistent disks are available only on paid web services. The blueprint selects `plan: pro` for 4 GB of memory; change the plan if you need more or can accept less.

Do not rely on Render's ephemeral filesystem for SQLite or APKs: that is why the disk is part of the blueprint. A disk limits the service to a single instance and prevents zero-downtime deploys.

This is a web service only. There is no background worker, because builds run inside the web service process.

Deploy button, once the repository is public at the configured address:

```
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER)
```
