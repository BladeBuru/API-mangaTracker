# =============================================================================
# Dockerfile — 3 stages (dev / build / production)
# =============================================================================

###################
# STAGE 1 — Development
###################
FROM node:20-alpine AS development

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
RUN npm ci

COPY --chown=node:node . .

USER node

###################
# STAGE 2 — Build
###################
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .

RUN npm run build

ENV NODE_ENV=production
RUN npm ci --only=production && npm cache clean --force

USER node

###################
# STAGE 3 — Production
###################
FROM node:20-alpine AS production

# Métadonnées de version injectées au build par la CI
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_DATE=${BUILD_DATE}

WORKDIR /usr/src/app

COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/main.js"]
