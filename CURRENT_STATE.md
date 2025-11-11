# USDC v2 Backend - Current State Summary

## Project Overview

**Project Name:** usdc-v2-backend  
**Version:** 0.1.0  
**Description:** Modular TypeScript backend for blockchain transaction tracking and Cosmos forwarding system  
**Architecture:** Clean Architecture with dependency injection (Awilix), modular design, ESM modules

## Tech Stack

### Runtime Dependencies
- **Fastify** (v5.6.1) - HTTP server framework
- **Prisma** (v6.19.0) - ORM for PostgreSQL
- **Awilix** (v12.0.5) - Dependency injection container
- **BullMQ** (v5.63.0) - Job queue (Redis-backed, not yet implemented)
- **ioredis** (v5.8.2) - Redis client (for BullMQ)
- **Pino** (v10.1.0) - Structured logging
- **Zod** (v4.1.12) - Schema validation
- **Axios** (v1.13.1) + **axios-retry** (v4.5.0) - HTTP client with retry logic
- **date-fns** (v4.1.0) - Date utilities
- **uuid** (v13.0.0) - UUID generation

### Development Dependencies
- **TypeScript** (v5.9.3) - Type system
- **tsx** (v4.20.6) - TypeScript execution for dev
- **tsup** (v8.5.0) - Production bundler (ESM + d.ts)
- **Vitest** (v4.0.7) - Test framework
- **ESLint** (v9.39.1) - Linting
- **Prettier** (v3.6.2) - Code formatting

## Project Structure

```
usdc-v2-backend/
├── src/
│   ├── app.ts                    # Application bootstrap & startup
│   ├── config/
│   │   ├── constants.ts          # App constants
│   │   ├── container.ts          # Awilix DI container setup
│   │   └── env.ts                # Environment config (Zod validation)
│   ├── common/
│   │   ├── db/
│   │   │   └── prismaClient.ts   # Prisma client singleton factory
│   │   ├── http/                 # (Empty - reserved for HTTP client utilities)
│   │   ├── rpc/                  # (Empty - reserved for RPC client abstractions)
│   │   └── utils/
│   │       └── logger.ts         # Pino logger factory
│   ├── modules/
│   │   ├── tx-tracker/
│   │   │   ├── controller.ts     # Fastify routes: POST /track, GET /tx/:hash
│   │   │   ├── repository.ts     # Prisma-backed repository (CRUD)
│   │   │   ├── service.ts        # Business logic layer
│   │   │   └── types.ts          # TypeScript interfaces
│   │   └── address-tracker/
│   │       ├── controller.ts     # Fastify routes: POST /register, GET /addresses
│   │       ├── repository.ts     # Prisma-backed repository (CRUD)
│   │       ├── service.ts        # Business logic layer
│   │       └── types.ts          # TypeScript interfaces
│   ├── jobs/
│   │   └── index.ts              # (Placeholder - BullMQ job registration)
│   ├── server/
│   │   ├── middleware.ts         # CORS registration
│   │   └── routes.ts              # Route registration orchestrator
│   └── utils/                     # (Empty - reserved for shared helpers)
├── prisma/
│   └── schema.prisma              # Database schema
├── package.json
├── tsconfig.json                  # TypeScript config (NodeNext, ESM)
├── eslint.config.js               # ESLint flat config
├── vitest.config.ts
├── tsup.config.ts
└── README.md
```

## Database Schema (Prisma)

### Models

1. **TrackedTransaction**
   - `id` (UUID, primary key)
   - `txHash` (String, unique) - Transaction hash
   - `chain` (String) - Chain identifier
   - `chainType` (String) - "evm" or "tendermint"
   - `status` (String) - Current status (e.g., "pending", "confirmed", "failed")
   - `metadata` (Json, optional) - Additional transaction metadata
   - `lastCheckedAt` (DateTime, optional) - Last polling timestamp
   - `nextCheckAfter` (DateTime, optional) - Next scheduled check
   - `errorState` (Json, optional) - Error details if tracking failed
   - `addressId` (String, optional, FK) - Related tracked address
   - `createdAt`, `updatedAt` (timestamps)
   - Relations: `address` (TrackedAddress), `statusLogs` (TransactionStatusLog[])

2. **TransactionStatusLog**
   - `id` (UUID, primary key)
   - `transactionId` (String, FK) - Parent transaction
   - `status` (String) - Status at this log entry
   - `detail` (Json, optional) - Status-specific details
   - `createdAt` (timestamp)
   - Relation: `transaction` (TrackedTransaction)

3. **TrackedAddress**
   - `id` (UUID, primary key)
   - `address` (String, unique) - Blockchain address
   - `chain` (String) - Chain identifier
   - `labels` (String[]) - User-defined labels
   - `metadata` (Json, optional) - Additional address metadata
   - `lastSyncedAt` (DateTime, optional) - Last sync timestamp
   - `createdAt`, `updatedAt` (timestamps)
   - Relations: `transactions` (TrackedTransaction[]), `checkpoints` (PollCheckpoint[])

4. **PollCheckpoint**
   - `id` (UUID, primary key)
   - `addressId` (String, optional, FK) - Related tracked address
   - `chain` (String) - Chain identifier
   - `cursor` (String, optional) - Polling cursor/offset
   - `height` (BigInt, optional) - Block height checkpoint
   - `metadata` (Json, optional) - Checkpoint metadata
   - `createdAt`, `updatedAt` (timestamps)
   - Relation: `address` (TrackedAddress)

## Current Implementation Status

### ✅ Completed

1. **Project Scaffold**
   - Node.js ESM project setup
   - TypeScript configuration (NodeNext, strict mode)
   - Build system (tsup for ESM + d.ts)
   - Linting (ESLint flat config) and formatting (Prettier)
   - Test framework (Vitest) configured

2. **Configuration & Infrastructure**
   - Environment variable validation (Zod schema)
   - Dependency injection container (Awilix)
   - Structured logging (Pino with pino-pretty for dev)
   - Prisma client singleton factory
   - Graceful shutdown handling

3. **Database Layer**
   - Prisma schema defined with all models
   - Prisma client generation working
   - Database connection lifecycle management

4. **Transaction Tracker Module**
   - **Repository**: Prisma-backed CRUD operations
     - `create()` - Create new tracked transaction
     - `findByHash()` - Lookup by transaction hash
     - `update()` - Update transaction status/metadata
   - **Service**: Business logic layer
     - `track()` - Register new transaction (handles duplicates)
     - `getByHash()` - Retrieve transaction by hash
   - **Controller**: HTTP endpoints
     - `POST /track` - Accept transaction tracking request (Zod validation)
     - `GET /tx/:hash` - Get transaction status by hash
   - **Types**: TypeScript interfaces aligned with Prisma schema

5. **Address Tracker Module**
   - **Repository**: Prisma-backed CRUD operations
     - `upsert()` - Create or update tracked address
     - `list()` - List all tracked addresses
     - `markSynced()` - Update last sync timestamp
     - `findByAddress()` - Lookup by address
   - **Service**: Business logic layer
     - `register()` - Register/upsert address (normalizes labels)
     - `list()` - List all tracked addresses
   - **Controller**: HTTP endpoints
     - `POST /register` - Register new address (Zod validation)
     - `GET /addresses` - List all tracked addresses
   - **Types**: TypeScript interfaces aligned with Prisma schema

6. **HTTP Server**
   - Fastify server with structured logging
   - CORS middleware configured
   - Health check endpoint (`GET /health`)
   - Route registration orchestrator

### ❌ Not Yet Implemented

1. **RPC Client Abstractions**
   - `src/common/rpc/` directory exists but empty
   - Need: EVM RPC client (JSON-RPC wrapper with retry/backoff)
   - Need: Tendermint RPC client (REST/WebSocket wrapper)
   - Need: Unified interface for querying transaction status

2. **HTTP Client Utilities**
   - `src/common/http/` directory exists but empty
   - Need: Retry wrapper around Axios
   - Need: Timeout/backoff configuration

3. **Job System (BullMQ)**
   - `src/jobs/index.ts` is placeholder only
   - Need: BullMQ queue setup and Redis connection
   - Need: Transaction status polling job (`txStatusPoller.ts`)
   - Need: Address polling job (`addressPoller.ts`)
   - Need: Job scheduling and repeatable jobs
   - Need: Resume-on-startup logic for unfinished transactions

4. **Transaction Status Tracking Logic**
   - Service layer has basic CRUD but no polling orchestration
   - Need: Status update logic based on RPC queries
   - Need: Status transition logging (TransactionStatusLog entries)
   - Need: Error handling and retry logic
   - Need: Resume tracking after server restart

5. **Cosmos Address Polling**
   - Address registration works, but no polling implementation
   - Need: Cosmos REST API client for balance/transaction queries
   - Need: Unsigned transaction construction
   - Need: Transaction submission to RPC

6. **Observability**
   - Basic logging exists, but no metrics
   - Need: Prometheus metrics endpoint (optional)
   - Need: Structured error tracking

## API Endpoints (Current)

### Transaction Tracker
- `POST /track`
  - Body: `{ txHash: string, chain: string, chainType: string, status?: string, metadata?: object, ... }`
  - Response: `{ data: TrackedTransaction }` (201)
  - Validates input with Zod, creates/returns existing transaction

- `GET /tx/:hash`
  - Params: `hash` (transaction hash)
  - Response: `{ data: TrackedTransaction }` (200) or `{ message: string }` (404)

### Address Tracker
- `POST /register`
  - Body: `{ address: string, chain: string, labels?: string[], metadata?: object }`
  - Response: `{ data: TrackedAddress }` (201)
  - Upserts address (creates or updates existing)

- `GET /addresses`
  - Response: `{ data: TrackedAddress[] }` (200)
  - Lists all tracked addresses

### System
- `GET /health`
  - Response: `{ status: "ok", uptime: number }` (200)

## Environment Variables

- `NODE_ENV` - Environment (development/test/production)
- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)
- `LOG_LEVEL` - Pino log level (default: info)
- `CORS_ORIGINS` - Comma-separated allowed origins
- `DATABASE_URL` - PostgreSQL connection string (optional)
- `REDIS_URL` - Redis connection string (optional, for BullMQ)
- `EVM_RPC_URLS` - Comma-separated EVM RPC endpoints (optional)
- `TENDERMINT_RPC_URLS` - Comma-separated Tendermint RPC endpoints (optional)

## Key Design Patterns

1. **Dependency Injection**: Awilix container manages all dependencies
2. **Repository Pattern**: Data access abstracted behind interfaces
3. **Service Layer**: Business logic separated from HTTP/DB concerns
4. **Clean Architecture**: Clear separation of concerns (presentation → application → domain → infrastructure)
5. **Type Safety**: Full TypeScript coverage with Prisma-generated types
6. **JSON Handling**: Helper functions for Prisma Json field casting

## Next Steps for Transaction Status Tracking

Based on the planner's outline, the next implementation tasks are:

1. **Build RPC Client Abstractions** (`src/common/rpc/`)
   - Implement `evmClient.ts` with JSON-RPC methods (getTransaction, getTransactionReceipt)
   - Implement `tendermintClient.ts` with REST methods (tx_search, tx)
   - Add retry/backoff logic using axios-retry
   - Unified interface for status queries

2. **Implement Transaction Status Polling Job** (`src/jobs/txStatusPoller.ts`)
   - BullMQ worker that polls RPC endpoints
   - Updates `TrackedTransaction` status based on RPC results
   - Creates `TransactionStatusLog` entries for status transitions
   - Handles errors and schedules retries via `nextCheckAfter`

3. **Resume Logic on Startup**
   - Query database for transactions with `nextCheckAfter < now()`
   - Enqueue polling jobs for unfinished transactions
   - Ensure no transactions are lost after server restart

4. **Service Layer Enhancements**
   - Add status update methods to `TxTrackerService`
   - Integrate RPC clients into service layer
   - Add status transition validation

5. **Job System Setup**
   - Configure BullMQ queues and Redis connection
   - Register repeatable jobs for periodic polling
   - Implement graceful job shutdown

## Testing Status

- Test framework (Vitest) configured
- No test files exist yet
- All scripts pass: `lint`, `build`, `test` (passes with `--passWithNoTests`)

## Build & Run

```bash
# Development
npm run dev          # Start with tsx watch mode

# Production
npm run build        # Bundle with tsup
npm start            # Run from dist/

# Quality
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest
```

## Notes

- All code uses ESM modules (`import`/`export`)
- TypeScript strict mode enabled
- Prisma client is singleton (managed via factory)
- JSON fields in Prisma require explicit casting helpers
- Container disposal handled in shutdown hooks
- No migrations have been run yet (schema defined but not applied to DB)

