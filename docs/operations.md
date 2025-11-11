# Backend Operations Guide

This guide covers operational tasks for the USDC v2 Backend, including database management, backups, and deployment operations.

## Table of Contents

- [Starting and Stopping Services](#starting-and-stopping-services)
- [Database Migrations](#database-migrations)
- [Database Backup and Restore](#database-backup-and-restore)
- [Clearing the Database](#clearing-the-database)
- [Production Backup Strategy](#production-backup-strategy)
- [Redis Operations](#redis-operations)
- [Environment Configuration](#environment-configuration)

## Starting and Stopping Services

### Development Environment

Start all services (backend, Postgres, Redis):
```bash
docker compose -f docker-compose.dev.yml up
```

Start in detached mode:
```bash
docker compose -f docker-compose.dev.yml up -d
```

Stop all services:
```bash
docker compose -f docker-compose.dev.yml down
```

Stop and remove volumes (⚠️ **WARNING**: This deletes all data):
```bash
docker compose -f docker-compose.dev.yml down -v
```

View logs:
```bash
docker compose -f docker-compose.dev.yml logs -f backend
```

### Production Environment

Start all services:
```bash
docker compose up -d
```

Stop all services:
```bash
docker compose down
```

Restart a specific service:
```bash
docker compose restart backend
```

## Database Migrations

### Running Migrations

**Development:**
```bash
# Using npm script (runs Prisma migrate dev)
npm run prisma:migrate

# Or directly with Prisma
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate dev
```

**Production:**
```bash
# Run migrations in production container
docker compose exec backend npx prisma migrate deploy
```

### Creating a New Migration

```bash
# Generate migration from schema changes
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate dev --name your_migration_name
```

### Resetting the Database (Development Only)

⚠️ **WARNING**: This deletes all data and recreates the database.

```bash
# Stop services and remove volumes
docker compose -f docker-compose.dev.yml down -v

# Start services (will recreate database)
docker compose -f docker-compose.dev.yml up -d

# Run migrations
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate deploy
```

## Database Backup and Restore

### Manual Backup

**Using Docker Compose:**
```bash
# Backup Postgres database
docker compose exec postgres pg_dump -U postgres usdc_v2_backend > backup_$(date +%Y%m%d_%H%M%S).sql

# Or using docker directly
docker exec usdc-v2-backend-postgres pg_dump -U postgres usdc_v2_backend > backup.sql
```

**Using pg_dump directly (if Postgres is accessible):**
```bash
pg_dump -h localhost -U postgres -d usdc_v2_backend > backup.sql
```

### Restore from Backup

**Using Docker Compose:**
```bash
# Restore from backup file
docker compose exec -T postgres psql -U postgres -d usdc_v2_backend < backup.sql

# Or using docker directly
docker exec -i usdc-v2-backend-postgres psql -U postgres -d usdc_v2_backend < backup.sql
```

**Using psql directly:**
```bash
psql -h localhost -U postgres -d usdc_v2_backend < backup.sql
```

### Backup Format Options

**Custom format (recommended for large databases):**
```bash
# Create backup
docker compose exec postgres pg_dump -U postgres -Fc usdc_v2_backend > backup.dump

# Restore
docker compose exec -T postgres pg_restore -U postgres -d usdc_v2_backend < backup.dump
```

**Compressed backup:**
```bash
# Create compressed backup
docker compose exec postgres pg_dump -U postgres usdc_v2_backend | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore
gunzip < backup.sql.gz | docker compose exec -T postgres psql -U postgres -d usdc_v2_backend
```

## Clearing the Database

⚠️ **WARNING**: This permanently deletes all data.

### Development

**Option 1: Reset via Prisma (recommended)**
```bash
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate reset
```

**Option 2: Drop and recreate database**
```bash
# Stop services
docker compose -f docker-compose.dev.yml down

# Remove Postgres volume
docker volume rm usdc-v2-backend_postgres-dev-data

# Start services (will recreate database)
docker compose -f docker-compose.dev.yml up -d

# Run migrations
docker compose -f docker-compose.dev.yml exec backend npx prisma migrate deploy
```

### Production

**⚠️ EXTREME CAUTION**: Only use in emergency situations.

```bash
# Connect to Postgres
docker compose exec postgres psql -U postgres -d usdc_v2_backend

# Drop all tables (inside psql)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;

# Exit psql and run migrations
exit
docker compose exec backend npx prisma migrate deploy
```

## Production Backup Strategy

### Automated Backup Script

Create a backup script (`scripts/backup.sh`):

```bash
#!/bin/bash
set -e

BACKUP_DIR="/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/usdc_v2_backend_$TIMESTAMP.dump"
RETENTION_DAYS=30

# Create backup
docker compose exec -T postgres pg_dump -U postgres -Fc usdc_v2_backend > "$BACKUP_FILE"

# Compress backup
gzip "$BACKUP_FILE"

# Remove backups older than retention period
find "$BACKUP_DIR" -name "usdc_v2_backend_*.dump.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: $BACKUP_FILE.gz"
```

### Cron Job Setup

Add to crontab for daily backups at 2 AM:

```bash
# Edit crontab
crontab -e

# Add this line (adjust path as needed)
0 2 * * * /path/to/scripts/backup.sh >> /var/log/usdc-backend-backup.log 2>&1
```

### Cloud Storage Backup

**Using AWS S3:**
```bash
#!/bin/bash
# Add to backup.sh after creating backup

# Upload to S3
aws s3 cp "$BACKUP_FILE.gz" s3://your-backup-bucket/usdc-v2-backend/

# Optional: Remove local backup after upload
# rm "$BACKUP_FILE.gz"
```

**Using Google Cloud Storage:**
```bash
# Upload to GCS
gsutil cp "$BACKUP_FILE.gz" gs://your-backup-bucket/usdc-v2-backend/
```

**Using Azure Blob Storage:**
```bash
# Upload to Azure
az storage blob upload --file "$BACKUP_FILE.gz" --container-name backups --name "usdc-v2-backend/$(basename $BACKUP_FILE.gz)"
```

### Backup Verification

Regularly verify backups are restorable:

```bash
# Test restore to a temporary database
docker compose exec postgres createdb -U postgres usdc_v2_backend_test
docker compose exec -T postgres pg_restore -U postgres -d usdc_v2_backend_test < backup.dump
docker compose exec postgres dropdb -U postgres usdc_v2_backend_test
```

## Redis Operations

### Viewing Redis Data

```bash
# Connect to Redis CLI
docker compose exec redis redis-cli

# List all keys
KEYS *

# Get value for a key
GET <key>

# Monitor commands in real-time
MONITOR
```

### Clearing Redis Data

⚠️ **WARNING**: This deletes all cached data and job queues.

```bash
# Clear all data
docker compose exec redis redis-cli FLUSHALL

# Clear only current database
docker compose exec redis redis-cli FLUSHDB
```

### Redis Backup

```bash
# Create Redis backup (RDB snapshot)
docker compose exec redis redis-cli BGSAVE

# Copy RDB file
docker cp usdc-v2-backend-redis:/data/dump.rdb ./redis_backup_$(date +%Y%m%d_%H%M%S).rdb
```

### Redis Restore

```bash
# Stop Redis
docker compose stop redis

# Copy RDB file back
docker cp redis_backup.rdb usdc-v2-backend-redis:/data/dump.rdb

# Start Redis
docker compose start redis
```

## Environment Configuration

### Required Environment Variables

Create a `.env` file in the project root:

```env
# Application
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=usdc_v2_backend
DATABASE_URL=postgresql://postgres:your_secure_password@postgres:5432/usdc_v2_backend

# Redis
REDIS_URL=redis://redis:6379

# CORS
CORS_ORIGINS=https://your-frontend-domain.com

# RPC Endpoints (comma-separated)
EVM_RPC_URLS=https://rpc.sepolia.org,https://sepolia.base.org
TENDERMINT_RPC_URLS=https://noble-testnet-rpc.polkachu.com,https://rpc.namada.world

# Optional: Chain Registry Override
CHAIN_REGISTRY_PATH=/path/to/chain-registry.json

# Optional: Chain Polling Config Override
CHAIN_POLLING_CONFIGS={"sepolia-testnet":{"maxDurationMin":15,"pollIntervalMs":3000}}
```

### Environment Variable Validation

The application validates all environment variables on startup. Invalid values will cause the application to fail to start with a clear error message.

## Health Checks

### Application Health

```bash
# Check application health endpoint
curl http://localhost:3000/health
```

### Database Health

```bash
# Check Postgres connection
docker compose exec postgres pg_isready -U postgres
```

### Redis Health

```bash
# Check Redis connection
docker compose exec redis redis-cli ping
```

## Monitoring and Logs

### View Application Logs

```bash
# Follow logs
docker compose logs -f backend

# View last 100 lines
docker compose logs --tail=100 backend

# View logs for all services
docker compose logs -f
```

### Log Levels

Set `LOG_LEVEL` environment variable:
- `trace`: Most verbose
- `debug`: Debug information
- `info`: General information (default)
- `warn`: Warnings only
- `error`: Errors only
- `fatal`: Fatal errors only

## Troubleshooting

### Database Connection Issues

```bash
# Check if Postgres is running
docker compose ps postgres

# Check Postgres logs
docker compose logs postgres

# Test connection
docker compose exec backend npx prisma db pull
```

### Redis Connection Issues

```bash
# Check if Redis is running
docker compose ps redis

# Check Redis logs
docker compose logs redis

# Test connection
docker compose exec redis redis-cli ping
```

### Application Won't Start

1. Check logs: `docker compose logs backend`
2. Verify environment variables are set correctly
3. Ensure database migrations have run: `docker compose exec backend npx prisma migrate status`
4. Check if ports are already in use: `lsof -i :3000`

### Performance Issues

1. Check resource usage: `docker stats`
2. Review application logs for errors
3. Check database query performance
4. Monitor Redis memory usage: `docker compose exec redis redis-cli INFO memory`

## Production Deployment Checklist

- [ ] Set strong `POSTGRES_PASSWORD` in `.env`
- [ ] Configure `CORS_ORIGINS` with actual frontend domain
- [ ] Set `LOG_LEVEL=info` or `warn` for production
- [ ] Configure RPC endpoints for all chains
- [ ] Set up automated backups (cron + cloud storage)
- [ ] Configure resource limits in `docker-compose.yml`
- [ ] Set up monitoring and alerting
- [ ] Test backup and restore procedures
- [ ] Document deployment process
- [ ] Set up SSL/TLS termination (via reverse proxy)

