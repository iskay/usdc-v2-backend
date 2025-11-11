# USDC v2 Backend

Modular TypeScript backend for blockchain transaction tracking and Cosmos forwarding system. Supports multi-chain transaction tracking for both deposit (EVM → Noble → Namada) and payment (Namada → Noble → EVM) flows.

## Features

- **Multi-Chain Transaction Tracking**: Track transactions across EVM, Noble, and Namada chains
- **Resumable Polling**: Automatically resume tracking after application restarts
- **Structured Status Updates**: Real-time status updates via WebSocket and REST API
- **Clean Architecture**: Modular design with dependency injection
- **Type-Safe**: Full TypeScript with strict typing
- **Production Ready**: Docker support, health checks, and operational tooling

## Quick Start

### First Time Setup

**Prerequisites:**
- Docker Desktop installed and running
- Just installed (optional, but recommended): `brew install just` or `cargo install just`

**Steps:**

1. **Set up environment variables:**
   ```bash
   cp .env.sample .env
   # Edit .env if needed (defaults work for Docker Compose)
   ```

2. **Start all services:**
   ```bash
   # Using Just (recommended)
   just up-d
   
   # Or using Docker Compose directly
   docker compose -f docker-compose.dev.yml up -d
   ```

3. **Run database migrations (required on first setup):**
   ```bash
   # Using Just
   just migrate
   
   # Or using Docker Compose directly
   docker compose -f docker-compose.dev.yml exec backend npx prisma migrate dev
   ```

4. **Verify everything is working:**
   ```bash
   # Check health endpoint
   curl http://localhost:3000/health
   
   # View logs
   just logs
   ```

The backend will be available at `http://localhost:3000` with hot-reload enabled.

### Development (Docker Compose)

**Using Just (recommended):**
```bash
# Install just: https://github.com/casey/just
# macOS: brew install just
# Linux: cargo install just

# Start all services (backend, Postgres, Redis)
just up

# Or in detached mode
just up-d

# Stop services
just down

# View logs
just logs

# Run migrations (after schema changes)
just migrate
```

**Using Docker Compose directly:**
```bash
# Start all services (backend, Postgres, Redis)
docker compose -f docker-compose.dev.yml up

# Or in detached mode
docker compose -f docker-compose.dev.yml up -d
```

See `justfile` for all available commands, or run `just --list` to see them.

**Important:** After starting containers for the first time, you must run migrations to create the database schema. See [Database Operations](#database-operations) for details.

### Development (Local)

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.sample .env  # Edit as needed

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start development server
npm run dev
```

### Production

```bash
# Build and start production stack
docker compose up -d

# View logs
docker compose logs -f backend
```

## Scripts

- `npm run dev` – Start Fastify in watch mode with `tsx`.
- `npm run build` – Bundle TypeScript using `tsup` (ESM output + d.ts).
- `npm run start` – Run the built server from `dist/`.
- `npm run lint` – Lint all `src/**/*.ts` files with ESLint.
- `npm run test` – Execute Vitest tests.
- `npm run format` – Format TypeScript sources with Prettier.
- `npm run prisma:generate` – Generate Prisma client.
- `npm run prisma:migrate` – Run database migrations.

## Project Structure

```
src/
  app.ts                # Application bootstrap
  config/               # env loader, DI container, constants, chain registry
  common/               # shared utilities (logger, rpc, db, http)
  server/               # middleware/route registrations, WebSocket
  modules/              # feature modules (tx-tracker, address-tracker)
    tx-tracker/         # Transaction tracking module
      pollers/         # Chain-specific polling services
      controller.ts    # REST API endpoints
      service.ts       # Business logic
      trackerManager.ts # Multi-chain flow orchestration
  jobs/                 # async job definitions (BullMQ)
  utils/                # shared helpers
```

## API Endpoints

### Transaction Tracking

- `POST /track` – Track a single transaction
- `POST /track/flow` – Start tracking a multi-chain flow
- `GET /flow/:id` – Get flow details by ID
- `GET /flow/:id/status` – Get flow status
- `POST /flow/:id/stage` – Append client-side stage update
- `GET /flow/by-hash/:chain/:hash` – Lookup flow by chain-specific hash
- `GET /tx/:hash` – Get transaction by hash

### Address Tracking

- `POST /register` – Register an address for tracking
- `GET /addresses` – List tracked addresses

### Health

- `GET /health` – Health check endpoint

## Environment Variables

See [docs/operations.md](./docs/operations.md#environment-configuration) for complete environment variable documentation.

Required variables:
- `DATABASE_URL` – PostgreSQL connection string
- `REDIS_URL` – Redis connection string
- `PORT` – Server port (default: 3000)
- `HOST` – Server host (default: 0.0.0.0)

Optional variables:
- `LOG_LEVEL` – Logging level (default: info)
- `CORS_ORIGINS` – CORS allowed origins
- `EVM_RPC_URLS` – Comma-separated EVM RPC endpoints
- `TENDERMINT_RPC_URLS` – Comma-separated Tendermint RPC endpoints
- `CHAIN_REGISTRY_PATH` – Path to custom chain registry JSON
- `CHAIN_POLLING_CONFIGS` – JSON string of chain polling configurations

## Database Operations

For detailed database operations, see [docs/operations.md](./docs/operations.md).

### Quick Reference

**Run migrations (required on first setup):**
```bash
# Using Just
just migrate

# Or using Docker Compose
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate dev

# Or locally (if not using Docker)
npm run prisma:migrate
```

**Backup database:**
```bash
docker compose -f docker-compose.dev.yml exec postgres pg_dump -U postgres usdc_v2_backend > backup.sql
```

**Restore database:**
```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d usdc_v2_backend < backup.sql
```

**Note:** If you see errors about tables not existing, you need to run migrations first. This is a common issue on first setup.

## Docker

### Development

Uses `Dockerfile.dev` with hot-reload support:
```bash
docker compose -f docker-compose.dev.yml up
```

### Production

Uses multi-stage `Dockerfile` with optimized build:
```bash
docker compose up -d
```

See [docs/operations.md](./docs/operations.md) for detailed Docker operations.

## Testing

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test -- --coverage
```

## Architecture

The backend follows clean architecture principles:

- **Dependency Injection**: Uses Awilix for DI container
- **Repository Pattern**: Data access abstraction via repositories
- **Service Layer**: Business logic in service classes
- **Job Queue**: BullMQ for async task processing
- **Event System**: Event emitter for status updates
- **RPC Abstraction**: Unified interface for EVM and Tendermint chains

## Chain Registry

The backend uses a chain registry to manage multi-chain configuration. By default, it includes:
- Ethereum Sepolia (testnet)
- Base Sepolia (testnet)
- Noble Testnet
- Namada Public Testnet

Custom chain registries can be provided via `CHAIN_REGISTRY_PATH` environment variable.

## License

Apache-2.0

