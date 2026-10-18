FROM node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0
WORKDIR /opt/graph-deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
RUN npm ci --no-audit --no-fund
COPY scripts/verify-project.mjs /opt/verify-project.mjs
WORKDIR /workspace
USER node
CMD ["node", "/opt/verify-project.mjs"]
