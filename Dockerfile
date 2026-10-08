# Wipboard, built for Google Cloud Run (it runs anywhere that runs containers).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    WIPBOARD_DATA=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# /data is where boards and uploads live; the container itself is disposable. The database there needs
# file locking, so it cannot live on a Cloud Storage bucket mount (see the note at the top of DEPLOY.md).
# The process runs as root so that whatever is mounted at /data is writable; Cloud Run sandboxes the
# container regardless.
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
