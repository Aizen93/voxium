# Running Voxium behind a reverse proxy

A public Voxium server sits behind a reverse proxy: it terminates TLS, serves the web client's static files and passes the API and the Socket.IO connection to the server process. This guide lists what the server expects from that proxy, why, and ends with one complete nginx configuration. Any proxy that can do the same works; nginx is the example because its directives map one to one onto the requirements.

Examples use `chat.example.com` for the public name and a server process listening on `127.0.0.1:3001`. Replace both with your own.

- [What goes through the proxy, and what does not](#what-goes-through-the-proxy-and-what-does-not)
- [TLS and HSTS](#tls-and-hsts)
- [Forwarded addresses: `TRUST_PROXY` and `TRUST_PROXY_HOPS`](#forwarded-addresses-trust_proxy-and-trust_proxy_hops)
- [WebSocket upgrade and timeouts](#websocket-upgrade-and-timeouts)
- [Request body sizes](#request-body-sizes)
- [Paths that must stay out of the proxy's logs](#paths-that-must-stay-out-of-the-proxys-logs)
- [The web client's static files](#the-web-clients-static-files)
- [Object storage: CORS for uploads](#object-storage-cors-for-uploads)
- [Optional: flood limits at the proxy](#optional-flood-limits-at-the-proxy)
- [A complete nginx example](#a-complete-nginx-example)

## What goes through the proxy, and what does not

| Traffic | Through the proxy? | Where it goes |
|---------|--------------------|---------------|
| `https://chat.example.com/api/v1/…` (REST API, attachment downloads, incoming webhooks) | yes | the server process (`PORT`, 3001 by default) |
| `https://chat.example.com/socket.io/…` (Socket.IO: HTTP long-polling first, then a WebSocket) | yes, with the WebSocket upgrade | the server process |
| Everything else on `https://chat.example.com/` | yes, served by the proxy itself | the web client's built files (`apps/desktop/dist`) |
| Voice media, UDP and TCP `MEDIASOUP_MIN_PORT`..`MEDIASOUP_MAX_PORT` | **no** | straight to the server's mediasoup ports, at `MEDIASOUP_ANNOUNCED_IP` |
| STUN for direct calls, 3478/udp | **no** | straight to coturn |
| File uploads (avatars, space icons, attachments) | **no** | straight from the client to the object storage, on a presigned URL |

The voice ports carry WebRTC media (DTLS-SRTP over UDP, TCP as a fallback): an HTTP proxy cannot carry them, and the server announces its own address for them. Open them in the firewall instead, as the README's Docker section describes.

`CORS_ORIGIN` names the origins browsers may call the API from: the web client's (`https://chat.example.com`) and the desktop app's (`https://tauri.localhost`, `tauri://localhost`, `http://tauri.localhost`).

With `NODE_ENV=production` the server trusts the `X-Forwarded-For` header (next sections), which only the proxy may set, so **clients reach the server process only through the proxy**. When the proxy runs on the same host, listen on (or publish the container's port on) the loopback address only, for example `"127.0.0.1:3001:3001"` in the `ports:` of `docker-compose.production.yml`; otherwise close the port in the firewall to everything but the proxy. With Docker, a firewall rule is not a reliable way to do that: ports Docker publishes bypass `ufw`'s rules, and `firewalld` gives Docker its own zone. Bind the published port to an address instead (`docker-compose.production.yml` publishes it on `127.0.0.1` unless `VOXIUM_HTTP_BIND` says otherwise).

## TLS and HSTS

The proxy terminates TLS: a certificate for `chat.example.com`, TLS 1.2 and 1.3, and a redirect from plain HTTP to HTTPS. The server process itself speaks plain HTTP to the proxy.

The server sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` on its own responses when `NODE_ENV=production`, but the static files of the web client never reach it, so the proxy must send the header for them. The simplest way is for the proxy to send it on every response and drop the server's copy, so each response carries exactly one. `includeSubDomains` tells browsers to use HTTPS for every subdomain of the name for a year: send it only when all of them serve HTTPS.

## Forwarded addresses: `TRUST_PROXY` and `TRUST_PROXY_HOPS`

Every per-address control in the server keys on the caller's address: the rate limits (sign-in, registration and its daily budgets, mail), IP bans, and the GitHub webhook source ranges. Behind a proxy the TCP peer is the proxy, so the server reads the address from `X-Forwarded-For`, by one rule shared by HTTP requests and the Socket.IO handshake (`apps/server/src/utils/trustProxy.ts`): with `TRUST_PROXY_HOPS=N` it takes the N-th entry from the right of the header (the leftmost when the header has fewer than N entries).

- The header is trusted when `NODE_ENV=production` or `TRUST_PROXY=true`.
- `TRUST_PROXY_HOPS` (default 1, an integer from 1 to 10; anything else is ignored with a warning and 1 is used) is the number of proxies between the internet and the server.
- Each proxy **appends** the address it received the request from (`$proxy_add_x_forwarded_for` in nginx), so the rightmost entries are written by your proxies and the ones further left by whoever sent the request.

| Topology | `TRUST_PROXY_HOPS` |
|----------|--------------------|
| One proxy (nginx) in front of the server | `1` (the default) |
| A load balancer or CDN in front of nginx, both appending to `X-Forwarded-For` | `2` |
| Two load balancers in front of nginx | `3` |

When the number is wrong:

- **Too low** (for example 1 behind a load balancer and nginx): every client is seen with the address of the load balancer. All of them share one rate-limit budget per control, so ordinary use runs into 429 answers, the registration budgets of the whole platform become one address's, and banning that address bans everyone.
- **Too high** (for example 2 behind nginx alone): the entry the server reads is the one the client wrote itself. A client can then pick the address it is limited and ban-checked as, spend another address's budgets, and slip out of an IP ban.
- **Not trusted at all** behind a proxy (`TRUST_PROXY` unset outside production): every client is the proxy's address. The server logs a warning the first time a request arrives with `X-Forwarded-For` while it does not trust it.

Change the topology and this number together, never one without the other.

## WebSocket upgrade and timeouts

The clients connect to Socket.IO at `/socket.io/` on `VITE_WS_URL`, first with HTTP long-polling, then upgrading to a WebSocket. The proxy must:

- speak HTTP/1.1 to the server and pass `Upgrade` and `Connection: upgrade` through for the WebSocket;
- keep a connection open longer than the server's heartbeat. The server pings every 25 seconds and gives up after 10 more (`pingInterval` 25000, `pingTimeout` 10000 in `apps/server/src/websocket/socketServer.ts`), and a long-polling request is answered within one ping interval. A read timeout of at least 60 seconds (nginx's default; the example sets 75) never cuts a healthy connection.
- if it keeps idle connections to the server open for reuse, close them before the server does: the server closes an idle connection after 65 seconds (`keepAliveTimeout`, `apps/server/src/index.ts`). nginx's `keepalive_timeout` for an upstream defaults to 60 seconds.
- with **more than one server process** behind it, send every request of one Socket.IO session to the same process (sticky sessions, for example `ip_hash` in the upstream block): long-polling sends a session's requests one by one, and a process that did not open the session refuses them. One process, as `docker-compose.production.yml` runs, needs nothing.

## Request body sizes

The server reads JSON request bodies of at most 100 KB everywhere, except the incoming-webhook execute route (`/api/v1/webhooks/…`), which takes up to 1 MiB (GitHub push deliveries are often larger than 100 KB). A Socket.IO long-polling request carries at most 1 MB. A proxy limit of 1 MiB for the whole site (`client_max_body_size 1m`, nginx's default) covers all three; a lower one breaks large webhook deliveries.

File uploads never go through the proxy: they go from the client to the object storage. If you put the object storage behind the same proxy, its own site needs a limit of at least 12 MiB (the largest attachment, a video).

## Paths that must stay out of the proxy's logs

Some URLs are credentials in themselves. Whoever reads a log that holds one can use it:

| Path | What the path holds |
|------|---------------------|
| `/api/v1/webhooks/<id>/<token>` | an incoming webhook's token: anyone holding the URL can post into the channel |
| `/api/v1/invites/<code>` | an invite code (the API's preview and join) |
| `/invite/<code>` | the same invite code, on the web client's page |
| `/verify-email/<token>`, `/reset-password/<token>`, `/mail-block/<token>` | the single-use links the server mails (`CLIENT_URL`): e-mail verification, password reset, blocking mail to an address |

The server keeps them out of its own logs: its access log prints `/api/v1/webhooks/<id>/[redacted]` and `/invites/[redacted]` (`apps/server/src/utils/redactUrl.ts`), and the web client's pages never reach it. A proxy with its default settings writes them down twice:

- the **access log** records the request line of each of them;
- the **error log** quotes the request line (and the `Referer`) when it logs a failure, for example an upstream error while the server restarts. Turning the access log off for those paths is therefore not enough.

So the proxy needs, for these paths, no access log and an error log that records only critical errors. Express matches routes without regard to case and the web client's router does the same, so match them case-insensitively too. In nginx, one location per kind of path:

```nginx
location ~* ^/api/v1/(webhooks|invites)/ {
    access_log off;
    error_log /var/log/nginx/voxium.error.log crit;
    proxy_pass http://voxium_server;
}
```

(nginx merges repeated slashes before it matches a location, so `/api/v1//webhooks/…` lands here too.)

Two more leaks to close:

- **The `Referer` header.** When the web client's page `/reset-password/<token>` loads its scripts or calls the API, the browser sends the page's address in `Referer`, and the default `combined` log format records it with every one of those requests. Send `Referrer-Policy: no-referrer` with the web client's pages, and log without `$http_referer`.
- **Query strings.** Log the path without its query (`$uri` rather than `$request` in nginx), so that a credential a client ever puts in a query string does not reach the access log either. The error log is a different matter: it quotes the request line of a failing request with its query, which is why the credential paths above also get a critical-only error log.

## The web client's static files

Build the web client with the URLs it is compiled for (`apps/desktop/.env.example` lists them: `VITE_API_URL=https://chat.example.com/api/v1`, `VITE_WS_URL=https://chat.example.com`) and copy `apps/desktop/dist` to the proxy:

```bash
pnpm build:shared
VITE_API_URL=https://chat.example.com/api/v1 VITE_WS_URL=https://chat.example.com pnpm build:desktop
```

The web client is a single-page application: `/login`, `/invite/<code>`, `/reset-password/<token>` and every other route are the same `index.html`, which reads the path itself. The proxy serves an existing file as it is and **falls back to `index.html`** for any other path, so a reload or a link opened from an e-mail finds the page. The files under `assets/` carry a content hash in their names and can be cached for a long time; `index.html` must not be, or browsers keep loading an old build after an update.

Set `CLIENT_URL` on the server to the same origin (`https://chat.example.com`): it is what the links in the e-mails start with. A desktop build hands out invite links on `VITE_CLIENT_URL` (see the README, "Build the Desktop App").

## Object storage: CORS for uploads

Avatars, space icons and attachments are uploaded with a `PUT` straight from the client to a presigned URL on the object storage, and avatars and icons are displayed from there (the server answers their requests with a redirect). Browsers send a CORS preflight before such a `PUT`, so the bucket's own CORS rules must allow every client origin: the web client's (`https://chat.example.com`) and the desktop app's (`https://tauri.localhost`, `tauri://localhost`, `http://tauri.localhost`), methods `GET`, `PUT` and `HEAD`, headers `*`. Without them uploads fail with an opaque "Failed to fetch" and nothing in the server's log, while images can still display. `scripts/setup-dev-bucket.ts` shows the rule for a development bucket. The proxy plays no part in this.

## Optional: flood limits at the proxy

The server limits requests itself (per user once signed in, per address otherwise). A per-address limit at the proxy (`limit_req`, `limit_conn` in nginx) can absorb a flood before it reaches the process, but one address often stands for many people (an office, a school, a mobile carrier's NAT), and one active client makes 35 to 60 API requests a minute plus its Socket.IO traffic. Size such a limit for a group behind one address, never for one user, and leave `/socket.io/` and `/api/v1/webhooks/` out of a request-rate limit.

## A complete nginx example

One public name for the web client, the API and Socket.IO, nginx on the same host as the server process (`127.0.0.1:3001`), the web client's files in `/var/www/voxium`. With it, the server's `.env.production` holds `TRUST_PROXY=true` (production turns it on anyway), `TRUST_PROXY_HOPS` unset (1), `CLIENT_URL=https://chat.example.com` and `CORS_ORIGIN=https://chat.example.com,https://tauri.localhost,tauri://localhost,http://tauri.localhost`.

```nginx
# /etc/nginx/conf.d/voxium.conf (inside the http block of nginx.conf)

# Access log lines with the path but neither the query string nor the
# Referer (see "Paths that must stay out of the proxy's logs")
log_format voxium '$remote_addr [$time_local] "$request_method $uri $server_protocol" '
                  '$status $body_bytes_sent $request_time';

# Connection: upgrade for a WebSocket handshake, nothing otherwise
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

upstream voxium_server {
    server 127.0.0.1:3001;
    # With several server processes, every Socket.IO session must stay on one:
    # ip_hash;
}

server {
    listen 80;
    listen [::]:80;
    server_name chat.example.com;
    # No access log here either: a server block with none of its own inherits
    # nginx's default log, which records the full request line (the path of
    # a webhook or an invite) of every request redirected to HTTPS
    access_log off;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;  # nginx 1.25.1 or later, see the notes below
    server_name chat.example.com;

    ssl_certificate     /etc/nginx/tls/chat.example.com.crt;
    ssl_certificate_key /etc/nginx/tls/chat.example.com.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    access_log /var/log/nginx/voxium.access.log voxium;
    error_log  /var/log/nginx/voxium.error.log;

    # On every response, the static files included. A location that sets an
    # add_header of its own drops these two, so none below does.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Referrer-Policy "no-referrer" always;

    # 1 MiB: the webhook execute route's limit, and a Socket.IO polling request's
    client_max_body_size 1m;

    # How every location below talks to the server process
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    # The server sends these two itself; nginx sends them for every response
    proxy_hide_header Strict-Transport-Security;
    proxy_hide_header Referrer-Policy;

    root  /var/www/voxium;
    index index.html;

    # The web client: a file as it is, any other path is the app
    location / {
        try_files $uri /index.html;
    }

    location = /index.html {
        expires -1;
    }

    location /assets/ {
        expires 1y;
        try_files $uri =404;
    }

    # The web client's pages whose path is a credential: the same app, out of both logs
    location ~* ^/(invite|verify-email|reset-password|mail-block)/ {
        access_log off;
        error_log /var/log/nginx/voxium.error.log crit;
        expires -1;
        try_files /index.html =404;
    }

    # The API
    location /api/ {
        proxy_pass http://voxium_server;
    }

    # The API paths whose URL is a credential: out of both logs
    location ~* ^/api/v1/(webhooks|invites)/ {
        access_log off;
        error_log /var/log/nginx/voxium.error.log crit;
        proxy_pass http://voxium_server;
    }

    # Socket.IO: long-polling, then the WebSocket upgrade (headers above)
    location /socket.io/ {
        proxy_pass http://voxium_server;
    }
}
```

Notes on the example:

- `http2 on;` needs nginx 1.25.1 or later; on an earlier release `nginx -t` rejects it (for example Ubuntu 24.04 and Debian 12 ship an older nginx). There, delete that line and write the option on the listen lines instead: `listen 443 ssl http2;` and `listen [::]:443 ssl http2;`.
- Both `server` blocks say what they log: the port-80 block turns the access log off, the port-443 block writes the `voxium` format and turns it off again for the credential paths.
- The access log shows `/index.html` as the path of every page the web client serves through its fallback, not the address the client asked for: `try_files` rewrites `$uri` internally.
- `proxy_pass` names no path, so the request goes to the server exactly as the client sent it, and nginx's own logs are the only place its line could have been written.
- Regular-expression locations (`~*`) take precedence over the plain prefixes `/` and `/api/`, which is what sends the credential paths to their own blocks.
- `/health` and `/ready` are not exposed: they are for the container's health check, on the server's own port.
- To reach the server only through nginx, publish its port on the loopback address (`"127.0.0.1:3001:3001"`) when it runs in `docker-compose.production.yml`.
