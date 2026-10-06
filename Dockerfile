# Wipboard, built for Google Cloud Run (it runs anywhere that runs containers).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    WIPBOARD_DATA=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# /data is where boards and uploads live. On Cloud Run mount a Cloud Storage bucket here (see
# DEPLOY.md); the container itself is disposable. The process runs as root because a mounted
# bucket is not owned by an unprivileged user; Cloud Run sandboxes the container regardless.
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
