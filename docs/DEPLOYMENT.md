# Deployment Guide — THE VOID

## 1. Docker Compose Deployment (Recommended)

The repository includes a production multi-stage `Dockerfile` and `docker-compose.yml` running PostgreSQL 16 and THE VOID server:

```bash
# Build and start PostgreSQL + THE VOID in detached mode
docker compose up -d --build

# Check container health and logs
docker compose ps
docker compose logs -f thevoid
```

Verify the health endpoint:

```bash
curl http://localhost:3000/api/health
```

---

## 2. Standalone Node.js + External PostgreSQL Deployment

1. **Provision PostgreSQL 15+**:
   Create a database and set `DATABASE_URL`:
   ```bash
   export DATABASE_URL="postgresql://user:password@db.example.com:5432/thevoid?sslmode=require"
   ```

2. **Install & Build**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ```

3. **Apply Migrations**:
   ```bash
   pnpm run db:migrate
   ```

4. **Start the Production Server**:
   ```bash
   export NODE_ENV=production
   export PORT=3000
   export HOST=0.0.0.0
   export ALLOWED_ORIGINS="https://your-void-domain.example.com"
   pnpm start
   ```

---

## 3. Reverse Proxy Configuration (Nginx / Caddy)

Ensure WebSocket upgrade headers are forwarded for `/ws`:

### Caddy (`Caddyfile`)
```caddyfile
your-void-domain.example.com {
    reverse_proxy localhost:3000
}
```

### Nginx
```nginx
server {
    listen 80;
    server_name your-void-domain.example.com;

    client_max_body_size 512k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```
