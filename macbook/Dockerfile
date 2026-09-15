# Native ARM64 editor/runtime image only. No product VSIX is baked into this image.
# Each job receives its own fresh registry retrieval through the pinned iMac relay.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip xvfb scrot xauth \
 libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libx11-xcb1 libxshmfence1 libdrm2 \
 libxcomposite1 libxdamage1 libxrandr2 libatk-bridge2.0-0 libcups2 xdg-utils fonts-dejavu-core \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
 && echo "deb [arch=arm64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
 && echo "deb [arch=arm64 signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update && apt-get install -y --no-install-recommends code nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/check
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY imac/*.cjs ./
COPY macbook/promptr-arm64-suite.cjs macbook/cognispec-arm64-suite.cjs ./
COPY helper ./helper
COPY macbook/relayed-registry.cjs ./registry-fetch.cjs
COPY macbook/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
ENTRYPOINT ["/opt/check/entrypoint.sh"]
