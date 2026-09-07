FROM node:24.20.0-slim

WORKDIR /app

# Dependencies first (better cache). No devDependencies in production.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application code.
COPY index.js ./
COPY src ./src

# The process runs as a non-privileged user. /data holds the OAuth store and is
# owned by appuser so a named volume mounted there inherits writable ownership.
RUN useradd --create-home --uid 10001 appuser \
 && mkdir -p /data/workspace && chown -R appuser:appuser /data
USER appuser

# Inside the container we listen on all interfaces; it is NOT published outward:
# -p 127.0.0.1:8001:8001 limits access to the local nginx only.
# B24_OAUTH_STORE_PATH points at the mounted volume so tokens survive a restart.
ENV B24_TRANSPORT=http \
    B24_HOST=0.0.0.0 \
    B24_PORT=8001 \
    B24_OAUTH_STORE_PATH=/data/oauth-state.json \
    B24_WORKSPACE_DIR=/data/workspace

EXPOSE 8001

CMD ["node", "index.js"]
