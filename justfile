# Backend Development Commands

# Start all services (backend, Postgres, Redis)
up:
    docker compose -f docker-compose.dev.yml up

# Start all services in detached mode
up-d:
    docker compose -f docker-compose.dev.yml up -d

# Stop all services
down:
    docker compose -f docker-compose.dev.yml down

# Stop all services and remove volumes (⚠️ deletes all data)
down-v:
    docker compose -f docker-compose.dev.yml down -v

# View backend logs
logs:
    docker compose -f docker-compose.dev.yml logs -f backend

# View all logs
logs-all:
    docker compose -f docker-compose.dev.yml logs -f

# View logs for a specific service
logs-service service:
    docker compose -f docker-compose.dev.yml logs -f {{service}}

# Run database migrations
migrate:
    docker compose -f docker-compose.dev.yml exec backend npx prisma migrate dev

# Reset database (⚠️ deletes all data)
db-reset:
    docker compose -f docker-compose.dev.yml exec backend npx prisma migrate reset

# Generate Prisma client
prisma-generate:
    docker compose -f docker-compose.dev.yml exec backend npx prisma generate

# Run tests
test:
    docker compose -f docker-compose.dev.yml exec backend npm run test

# Run linter
lint:
    docker compose -f docker-compose.dev.yml exec backend npm run lint

# Build the application
build:
    docker compose -f docker-compose.dev.yml exec backend npm run build

# Access backend container shell
shell:
    docker compose -f docker-compose.dev.yml exec backend sh

# Access Postgres shell
db-shell:
    docker compose -f docker-compose.dev.yml exec postgres psql -U postgres -d usdc_v2_backend

# Access Redis CLI
redis-cli:
    docker compose -f docker-compose.dev.yml exec redis redis-cli

# Check service status
status:
    docker compose -f docker-compose.dev.yml ps

# Restart backend service
restart:
    docker compose -f docker-compose.dev.yml restart backend

# Rebuild backend container
rebuild:
    docker compose -f docker-compose.dev.yml build backend

# Full restart (rebuild + restart)
restart-full:
    docker compose -f docker-compose.dev.yml build backend
    docker compose -f docker-compose.dev.yml restart backend

