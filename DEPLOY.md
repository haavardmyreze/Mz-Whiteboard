# Deploying Wipboard

Wipboard is one Node process: it serves the pages, holds each open board in memory so that edits
reach everyone instantly over WebSockets, and saves boards and uploads to a folder. That shape
decides how it should be hosted.

**Recommended: Google Cloud Run**, with a Cloud Storage bucket mounted as the data folder and Google
Identity-Aware Proxy (IAP) for sign-in. It matches the existing setup (Cloud Run server that wakes
on request, Cloud Storage buckets, autodeploy from GitHub) and needs no changes to how the app
stores things.

## What the app expects from its host

| Need | Why | How Cloud Run provides it |
| --- | --- | --- |
| Long-lived connections | Live cursors and edits are WebSockets | Supported; set the request timeout to the maximum (60 min). Browsers reconnect by themselves when a connection ends |
| **Exactly one instance** | The open board lives in that process's memory. Two instances would each hold a different copy | `--max-instances 1` |
| A folder that survives restarts | `data/boards`, `data/uploads`, `data/folders.json` | A Cloud Storage bucket mounted at `/data` |
| Light uploads | Heavy video is compressed on the uploader's own machine (H.264, 1080p, about 8 Mbps) before it is sent, so the server never encodes anything | Nothing to configure; the bucket only ever holds light files |
| Requests under the front end's size cap | Cloud Run limits a request body (32 MiB over HTTP/1 at the time of writing) | The app already uploads files in 8 MB pieces and joins them on the server |
| Clean shutdown | Edits are saved 0.8 s after the last change | On SIGTERM the app saves everything before it exits |
| A health check | | `GET /healthz` answers `ok` without a login |

Scale to zero is fine: boards are in the bucket, so a cold start just reloads them. Anyone connected
at that moment reconnects on their own.

## Deploy

Replace `REGION`, `BUCKET` and `PROJECT_NUMBER`.

```bash
# 1. a bucket for boards and uploads
gcloud storage buckets create gs://BUCKET --location=REGION --uniform-bucket-level-access

# 2. deploy straight from this repo (Cloud Build uses the Dockerfile)
gcloud run deploy wipboard --source . --region REGION \
  --no-allow-unauthenticated --iap \
  --max-instances 1 --timeout 3600 --concurrency 250 --memory 1Gi \
  --add-volume name=data,type=cloud-storage,bucket=BUCKET \
  --add-volume-mount volume=data,mount-path=/data \
  --set-env-vars AUTH_MODE=iap,IAP_AUDIENCE=/projects/PROJECT_NUMBER/locations/REGION/services/wipboard
```

Then, once:

```bash
# let the service read and write the bucket (use the service account the service runs as)
gcloud storage buckets add-iam-policy-binding gs://BUCKET \
  --member=serviceAccount:RUNTIME_SERVICE_ACCOUNT --role=roles/storage.objectUser

# IAP must be allowed to invoke the service
gcloud run services add-iam-policy-binding wipboard --region REGION \
  --member=serviceAccount:service-PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com --role=roles/run.invoker

# who may open the boards (repeat per person, or bind a Google group)
gcloud iap web add-iam-policy-binding --member=user:someone@example.com \
  --role=roles/iap.httpsResourceAccessor --region REGION --resource-type=cloud-run --service wipboard
```

Memory: a mounted bucket buffers about 64 MiB per file being written, so give the service at least
512 Mi, and 1 Gi if several people upload video at once.

### Autodeploy on push to `main`

In the Cloud Run console open the service, choose **Set up continuous deployment**, connect the
GitHub repository, set the branch to `^main$` and the build type to **Dockerfile**. Every push to
`main` then builds and redeploys. The settings above (volume, instance limit, environment) stay on
the service between deployments.

## Settings

All optional locally; the ones in bold matter when deployed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4680` (`8080` in the container) | Cloud Run sets this itself |
| `HOST` | `0.0.0.0` | Interface to listen on |
| **`WIPBOARD_DATA`** | `./data` (`/data` in the container) | Where boards and uploads are saved |
| `WIPBOARD_MAX_UPLOAD_MB` | `1024` | Largest accepted file |
| **`AUTH_MODE`** | `none` | `none` (everyone, picks a display name), `password` (name plus one shared password), `google` (Google accounts on an allow list, own PC) or `iap` (Google Cloud IAP) |
| **`IAP_AUDIENCE`** | | Required with `iap`: `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME` |
| `ALLOWED_EMAILS` | | Optional extra list, comma separated, narrower than who IAP admits |
| `ALLOWED_DOMAINS` | | Same, by domain, e.g. `myreze.com` |
| `SITE_PASSWORD` | | With `AUTH_MODE=password`: the one password everybody types with their name |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | With `AUTH_MODE=google`: the OAuth client from Google Cloud Console |
| `PUBLIC_URL` | | With `AUTH_MODE=google`: the address people use, no trailing slash. Also used for share links |
| `SESSION_SECRET` | made once, kept in `data/.session-secret` | Signs sign-in cookies; set it only to share sessions between restarts of different data folders |

With `AUTH_MODE=iap` the app checks the signed token Google adds to every request and refuses anything
without a valid one. People are then named from their Google account (cursor labels, presence), and
the name prompt disappears. The check is in `auth.js` and covered by `npm test`.

## Running it from your own PC with one shared password (simplest)

No Google, no domain, no cloud account. Everyone types their **name** and **one password** you choose.

1. In `.env` set `AUTH_MODE=password` and `SITE_PASSWORD=<the password>` (see `.env.example`), then run `start.bat`.
2. Install Cloudflare's tunnel program once: `winget install Cloudflare.cloudflared`.
3. Run `tunnel.bat`. Among its output is an address like `https://something-random.trycloudflare.com`.
   Share that address and the password. It works for anyone, anywhere, with nothing opened on your router.
4. The address changes every time `tunnel.bat` is started, and stops working when its window is closed.
   Read-only links made from that address stop working with it. A fixed address needs a domain (see below).

Good to know: the name is only a label. Anyone who knows the password can type any name, and two people who type the
same name share one Personal workspace. Wrong passwords are slowed down (8 tries per 10 minutes per address), and changing
`SITE_PASSWORD` signs everybody out. Cloudflare's free quick tunnels are meant for testing, with no uptime promise.

## Running it from your own PC, for people outside (Google sign-in)

No cloud account needed for the app itself. Three parts: Google sign-in, a public address, and a
tunnel to this PC.

**1. Google sign-in.** In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
(any project, free) create an *OAuth client ID* of type *Web application*. Under *Authorised redirect
URIs* add `PUBLIC_URL/auth/callback` (for example `https://boards.example.com/auth/callback`; add
`http://localhost:4680/auth/callback` as well to try it on this PC). Copy `.env.example` to `.env` and fill in
the client ID and secret, `PUBLIC_URL`, and who may sign in (`ALLOWED_EMAILS`, `ALLOWED_DOMAINS`).
Restart with `start.bat`. Strangers are sent to a sign-in page; a Google account not on the list is refused.
Changes to the list take effect on restart.

**2. A public address and tunnel.** The simplest safe route is a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
a domain on Cloudflare (about $10 a year), `cloudflared` installed on this PC as a service, and a
tunnel that sends `boards.example.com` to `http://localhost:4680`. It makes only an outbound
connection, so no router ports are opened, and it provides HTTPS. Do not add Cloudflare Access in front:
the app does its own sign-in, and read-only links must stay reachable without one. Set `HOST=127.0.0.1` in
`.env` so the tunnel is the only way in from outside (people on your own network then use the public address too).

**3. Keep it up.** The PC must stay awake and on. Back up the `data` folder; it holds every board and upload.

### Read-only links

On a board, **Share** makes a link such as `PUBLIC_URL/s/<secret>`. Anyone holding it can watch the
board live and open images and videos, with no sign-in. They cannot change anything (the server ignores
anything they send, not just the buttons being hidden), they do not appear to the team, and they do not see
comments. **Stop sharing** kills the link at once and disconnects whoever is watching. Treat a link like a
password: whoever has it can view the board. The links work in `none` and `google` modes, not behind IAP.

Uploaded files are served under hard-to-guess names. They load for signed-in people, and for a browser that has
just opened a live read-only link, and for nobody else.

## Using Vercel and Next.js instead

It can be done, but it is a larger change than it looks, because the part that needs rewriting is the
server rather than the pages:

- A Vercel function is not one shared long-lived process. Vercel has announced WebSocket support in
  beta, but board state would still need to live somewhere every function can reach, so we would add
  a realtime service (Liveblocks, PartyKit, Ably) or move live state into a database.
- Request bodies to a function are small, so uploads would go straight from the browser to object
  storage (Vercel Blob or the Cloud Storage buckets) using signed URLs.
- Sign-in would be Clerk rather than IAP. `auth.js` is the one file that decides who is signed in, so a
  Clerk check could slot in next to `iap`.

If the team prefers that route, the canvas code (`public/`) carries over; the server, storage and
sync would be rebuilt around those services. Cloud Run needs none of that, which is why it is the
default here.

## Run it locally

```bash
npm install
npm start        # http://localhost:4680, data in ./data
npm test         # sign-in checks and piece-by-piece uploads
```
