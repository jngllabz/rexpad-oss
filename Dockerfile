FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY onchain/target/idl ./onchain/target/idl
# Which stand-in mint each quote resolves to on a test cluster. Without it a devnet build has no
# quotes at all — see the guard in lib/prices.mjs.
COPY devnet-mints.json ./
# The operator tools ship with the image. The fee crank is the one that matters: it claims REX's
# side of every Meteora pool fee and divides it, and it has to run WHERE THE DATABASE IS. Leaving
# tools out meant `fly ssh console -C "node tools/fee_crank.mjs"` died on MODULE_NOT_FOUND, so the
# only revenue path the launchpad has after the move to Meteora could not be run on mainnet at all.
# They are plan-only unless given --execute, and none of them is reachable over HTTP.
COPY tools ./tools
# The commit this image was built from, served at /version.txt so the forward-only deploy gate can
# read what is actually running. scripts/deploy.sh always passes it.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
CMD ["node", "server.mjs"]
