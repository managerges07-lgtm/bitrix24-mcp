# VPS deployment (Docker Compose + existing nginx)

Layout: each MCP server runs in Docker on its own local port (`127.0.0.1:800X`),
and the existing nginx proxies a **subdomain** to it over HTTPS. No Caddy needed —
nginx does the TLS (certbot).

This server: subdomain `btrx-mcp.texpertiza.ru`, port `8001`.
(The neighbor `kontur-mcp.texpertiza.ru` already uses `8000`.)

## 0. DNS

A record `btrx-mcp.texpertiza.ru` → VPS IP.

## 1. Code on the server

```bash
git clone <repo> /opt/bitrix24-mcp   # or copy the project folder
cd /opt/bitrix24-mcp
```

## 2. .env on the server

Create `/opt/bitrix24-mcp/.env`:

```
# Bitrix24 incoming webhook (credential SHARED by all authorized users).
B24_DEFAULT_WEBHOOK=https://your-portal.bitrix24.com/rest/1/your-token/

# Knowledge Base 2.0 (b24_kb2_* tools) — needs the `note` scope, which usually lives on a
# personal webhook. Also decides who authors the documents. Optional; without it those
# tools fall back to the webhook above and will answer 403 if it has no `note` scope.
B24_NOTE_WEBHOOK=https://your-portal.bitrix24.com/rest/359/your-token/

# Optional: exact additional hosts allowed for per-call webhook_url overrides.
# Hosts from B24_DEFAULT_WEBHOOK and B24_NOTE_WEBHOOK are allowed automatically.
# B24_ALLOWED_WEBHOOK_HOSTS=another-portal.bitrix24.com

B24_TRANSPORT=http
B24_HOST=0.0.0.0
B24_PORT=8001
B24_PUBLIC_URL=https://btrx-mcp.texpertiza.ru
B24_GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com
B24_GOOGLE_CLIENT_SECRET=GOCSPX-<...>
B24_ALLOWED_EMAILS=manager.ges.07@gmail.com

# File tools are restricted to this persistent subdirectory. Docker sets the
# same value by default; keep it separate from /data/oauth-state.json.
B24_WORKSPACE_DIR=/data/workspace
```

> `B24_PUBLIC_URL` with no trailing slash. The redirect URI in Google must be
> exactly `https://btrx-mcp.texpertiza.ru/auth/callback`.
>
> ⚠️ Every email in `B24_ALLOWED_EMAILS` shares the SAME Bitrix24 webhook and can
> run any REST method (including `b24_call`). The allowlist is the only barrier of
> who may use that webhook — keep it short.

## 3. Build and run

```bash
docker compose up -d --build
docker compose logs -f bitrix24-mcp    # wait for "HTTP MCP listening on 0.0.0.0:8001"
docker compose ps                      # STATUS should become (healthy) in ~10-40s
curl -s http://127.0.0.1:8001/health   # {"status":"ok"}
```

`/health` is public (no OAuth) to check the server is alive; the healthcheck in
`docker-compose.yml` uses it too. The MCP protocol is served at the ROOT (`/`),
so the connector URL has **no `/mcp`** (see step 6).

The port is bound to `127.0.0.1` — not published outward, only nginx reaches it.

## 4. nginx + TLS

```bash
sudo cp deploy/nginx-mcp.conf /etc/nginx/sites-available/bitrix24-mcp
sudo ln -s /etc/nginx/sites-available/bitrix24-mcp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d btrx-mcp.texpertiza.ru
```

## 5. Google OAuth

The SAME Google OAuth project/client as `kontur-mcp` is reused — no need to create
a new app. In Google Cloud Console, on that OAuth client:

- Authorized redirect URIs: **add** `https://btrx-mcp.texpertiza.ru/auth/callback`
  (alongside the kontur one, without removing it).
- Consent screen: External, Testing mode, with the emails in Test users.

## 6. Connect in Claude

Claude → **Settings → Connectors** → Add custom connector →
URL `https://btrx-mcp.texpertiza.ru` (domain root, **no `/mcp`**).
Complete the Google login. An email outside `B24_ALLOWED_EMAILS` gets a 403.

---

## Several MCP servers on one VPS

Model: **subdomain + local port per server** (not paths on a single domain —
otherwise the OAuth `/.well-known/*` and `/auth/callback` would collide at the root).

To add another MCP server:
1. **Port:** give it its own (`127.0.0.1:8002`, …).
2. **DNS:** A record for the new subdomain → VPS IP.
3. **nginx:** copy `nginx-mcp.conf`, change `server_name` and `proxy_pass` (port),
   then `certbot --nginx -d <new-subdomain>`.
4. **OAuth:** in the same Google app add another redirect URI
   `https://<new-subdomain>/auth/callback` — no separate app needed.
5. **Claude:** add the connector `https://<new-subdomain>`.

## Security

**`.env` permissions** (it holds the Bitrix webhook and the Google secret):
```bash
chmod 600 /opt/bitrix24-mcp/.env
```
`.env` is not committed (it's in `.gitignore`) and not baked into the image — it's
passed at runtime via `env_file`. The process runs as the non-privileged `appuser`.

**Firewall (ufw):** outward only SSH and web; the container ports (8000+) stay
closed — and they only listen on `127.0.0.1` anyway.

**OAuth store (`oauth-data` volume):** the provider persists registered clients
and access/refresh tokens to `/data/oauth-state.json` (path from
`B24_OAUTH_STORE_PATH`, set in the Dockerfile) so they survive a restart. The
file is written `0600` and lives in a Docker named volume owned by `appuser`
(uid 10001). It holds bearer tokens — treat it like a credential. To force all
users to re-login, remove the volume: `docker compose down && docker volume rm bitrix24-mcp_oauth-data`.

**Workspace:** file-based tools can read and write only below
`B24_WORKSPACE_DIR` (`/data/workspace` in Docker). Absolute paths outside it,
path traversal and symlink escapes are rejected. This prevents access to the
OAuth token store and other container files.

**Destructive calls:** CRM deletion, Knowledge Base 2.0 document deletion,
configuration apply, and destructive methods sent through `b24_call`/`b24_batch`
require `confirm: true`.

## Updating a version

```bash
cd /opt/bitrix24-mcp && git pull
docker compose up -d --build
```

## Troubleshooting

- `docker compose logs -f bitrix24-mcp` — server logs.
- nginx 502 → the container didn't start / crashed (`docker compose ps`).
- OAuth doesn't pass → exact redirect URI match and email in `B24_ALLOWED_EMAILS`.
- OAuth clients and tokens persist in the `oauth-data` volume
  (`/data/oauth-state.json`), so a normal restart / redeploy keeps users logged
  in. A re-login is only needed if that volume is removed
  (`docker compose down -v`) or the store file is deleted.
