# NUWACO WMS - Deployment & Configuration Guide

## Overview
NUWACO WMS is a comprehensive LoRaWAN-based Water Meter Management System built with modern technologies:
- **Frontend**: Next.js 14 with React Query, Zustand, TailwindCSS
- **Backend**: Node.js Express API with JWT authentication
- **Database**: PostgreSQL 16
- **Messaging**: MQTT (Mosquitto) for LoRaWAN device communication
- **Infrastructure**: Docker & Docker Compose

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / Client                      │
└────────────────────────────┬────────────────────────────┘
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────┐
│           Nginx Reverse Proxy & Load Balancer           │
├─────────────────────────────────────────────────────────┤
│  ┌────────────────┐          ┌─────────────────────┐   │
│  │  Next.js (3000)├─────────┤  Express API (5000)  │   │
│  │   Frontend     │          │    Backend          │   │
│  └────────────────┘          └──────────┬──────────┘   │
│                                         │               │
│  ┌────────────────┐     ┌───────────────┴────────────┐ │
│  │ PostgreSQL     │     │  MQTT (1883/8883)          │ │
│  │ (5432)         │◄───►│  LoRaWAN Integration       │ │
│  └────────────────┘     └────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                             ▲
                             │ MQTT
                             ▼
        ┌──────────────────────────────────┐
        │     ChirpStack / LoRaWAN         │
        │       Gateway & Server           │
        └──────────────────────────────────┘
```

## Quick Start

### Prerequisites
- Docker & Docker Compose
- 2GB RAM minimum (4GB recommended)
- 5GB disk space
- Ports 80, 443, 3000, 5000, 5432, 1883 available

### Automatic Deployment (Recommended)

```bash
# Make script executable
chmod +x scripts/deploy.sh

# Run deployment script
./scripts/deploy.sh
```

The script will:
1. Create necessary directories
2. Generate secure JWT secrets
3. Build Docker images
4. Start all services
5. Initialize the database
6. Seed demo accounts
7. Perform health checks

### Manual Deployment

```bash
# 1. Build images
docker-compose build

# 2. Start services
docker-compose up -d

# 3. Wait for PostgreSQL
docker-compose exec postgres pg_isready -U geedsan

# 4. Seed database with demo users
docker-compose exec backend npm run seed

# 5. Verify
curl http://localhost:5000/health
curl http://localhost:3000
```

## Default Demo Accounts

All passwords are set to the defaults below. **CHANGE THESE IN PRODUCTION**:

| Username | Password | Role | Email |
|----------|----------|------|-------|
| admin | Admin@Geedsan2024 | Admin | admin@geedsan.com |
| operator1 | Operator@2024 | Operator | operator@geedsan.com |
| viewer1 | Viewer@2024 | Viewer | viewer@geedsan.com |

## Configuration

### Environment Variables (.env)

```bash
# Database
DB_PASSWORD=GeedSan@Secure2024  # Change in production
DB_HOST=postgres
DB_PORT=5432
DB_NAME=geedsan_wms
DB_USER=geedsan

# JWT Security
JWT_SECRET=your-secret-key-here          # Generated automatically
JWT_REFRESH_SECRET=your-refresh-secret   # Generated automatically

# URLs
NEXT_PUBLIC_API_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000

# MQTT/LoRaWAN
MQTT_BROKER=mqtt://mqtt:1883
MQTT_CLIENT_ID=geedsan-backend
MQTT_TOPICS=application/+/device/+/event/up,application/+/device/+/event/join

# ChirpStack Integration
CHIRPSTACK_URL=http://chirpstack:8080
CHIRPSTACK_API_KEY=your-api-key
CHIRPSTACK_TENANT_ID=your-tenant-id

# Email Notifications
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Optional Features
TELEGRAM_BOT_TOKEN=your-token
ANTHROPIC_API_KEY=your-api-key
```

### Production Checklist

- [ ] Change all default passwords
- [ ] Generate new JWT secrets
- [ ] Set up SSL certificates
- [ ] Configure email service
- [ ] Set up regular backups
- [ ] Configure CORS properly
- [ ] Set NODE_ENV=production
- [ ] Enable rate limiting
- [ ] Set up monitoring
- [ ] Configure MQTT authentication
- [ ] Test disaster recovery

## Services

### Frontend (Next.js)
- **Port**: 3000
- **URL**: http://localhost:3000
- **Features**: Dashboard, metrics, alerts, reports, user management
- **Health Check**: GET http://localhost:3000

### Backend API (Express)
- **Port**: 5000
- **URL**: http://localhost:5000/api
- **Docs**: All endpoints documented in `backend/src/routes/`
- **Health Check**: GET http://localhost:5000/health

### Database (PostgreSQL)
- **Port**: 5432
- **Database**: geedsan_wms
- **User**: geedsan
- **Volume**: postgres_data (persisted)
- **Init Script**: database/schema.sql

### MQTT Broker (Mosquitto)
- **TCP Port**: 1883
- **WebSocket Port**: 8883
- **Topics**: 
  - `application/+/device/+/event/up` (uplink data)
  - `application/+/device/+/event/join` (join events)
  - `application/+/device/+/event/status` (status updates)
- **Volume**: mqtt_data (persisted)

### Nginx (Reverse Proxy)
- **Ports**: 80, 443
- **Config**: docker/nginx.conf
- **Function**: Load balancing, SSL termination

## Monitoring

### Check Service Status
```bash
# All services
docker-compose ps

# Backend logs
docker-compose logs -f backend

# Database logs
docker-compose logs -f postgres

# MQTT logs
docker-compose logs -f mqtt
```

### Health Endpoints

```bash
# API Health
curl http://localhost:5000/health

# Database Status (via API)
curl http://localhost:5000/health | jq '.db'

# Frontend
curl http://localhost:3000
```

## Backup & Recovery

### Backup Database
```bash
docker-compose exec postgres pg_dump -U geedsan geedsan_wms > backup.sql
```

### Restore Database
```bash
docker-compose exec -T postgres psql -U geedsan geedsan_wms < backup.sql
```

### Backup Volumes
```bash
# Backup persistent data
docker run --rm -v geedsan_postgres_data:/data -v $(pwd):/backup ubuntu tar czf /backup/postgres-backup.tar.gz -C /data .
docker run --rm -v geedsan_mqtt_data:/data -v $(pwd):/backup ubuntu tar czf /backup/mqtt-backup.tar.gz -C /data .
```

## ChirpStack Integration

### Setting up ChirpStack MQTT

1. Install ChirpStack Application Server
2. Configure MQTT broker integration pointing to `mqtt://mqtt:1883`
3. Set application topics to include device uplink/join events
4. Update CHIRPSTACK_URL, CHIRPSTACK_API_KEY in .env
5. Backend will automatically subscribe and process messages

### Expected MQTT Message Format
```json
{
  "applicationID": "1",
  "applicationName": "GeedSan",
  "deviceName": "Meter-001",
  "deviceEUI": "0102030405060708",
  "rxInfo": [{
    "rssi": -80,
    "snr": 7.5
  }],
  "txInfo": {},
  "fPort": 5,
  "fCnt": 123,
  "objectJSON": {
    "consumption": 1234.5,
    "flow": 45.2,
    "battery": 3.3
  }
}
```

## Development

### Running Locally Without Docker
```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

### Running Tests
```bash
# Backend tests
docker-compose exec backend npm test

# Frontend tests
docker-compose exec frontend npm test
```

### Database Migrations
Schema changes are applied via `database/schema.sql` during initialization.
For new tables/columns, update the schema and run:
```bash
docker-compose exec postgres psql -U geedsan geedsan_wms -f /docker-entrypoint-initdb.d/01-schema.sql
```

## Security Best Practices

1. **JWT Secrets**: Use strong, randomly generated secrets
2. **Database**: Use strong password and restrict network access
3. **MQTT**: Enable authentication for production
4. **SSL/TLS**: Always use HTTPS in production
5. **CORS**: Configure to specific domains only
6. **Rate Limiting**: Already enabled on API endpoints
7. **Environment Variables**: Never commit .env to Git
8. **Dependencies**: Keep all packages updated

## Troubleshooting

### Frontend Not Loading
```bash
# Check if service is running
docker-compose ps frontend

# Check logs
docker-compose logs frontend

# Restart service
docker-compose restart frontend
```

### API Connection Issues
```bash
# Check backend health
curl http://localhost:5000/health

# Verify CORS configuration
curl -H "Origin: http://localhost:3000" http://localhost:5000/health

# Check logs
docker-compose logs backend
```

### Database Connection Failed
```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# Check database logs
docker-compose logs postgres

# Test connection
docker-compose exec postgres psql -U geedsan -d geedsan_wms -c "SELECT 1"
```

### MQTT Not Receiving Messages
```bash
# Subscribe to test topic
docker exec geedsan-mqtt mosquitto_sub -h localhost -t "application/+/device/+/event/up"

# Check MQTT logs
docker-compose logs mqtt

# Verify ChirpStack MQTT bridge configuration
```

## API Documentation

### Authentication
All endpoints (except `/health`) require Bearer token in Authorization header:
```
Authorization: Bearer <access_token>
```

### Key Endpoints

#### Meters
- `GET /api/meters` - List all meters
- `GET /api/meters/:id` - Get meter details
- `GET /api/meters/:id/readings` - Get readings history

#### Alarms
- `GET /api/alarms` - List alarms
- `POST /api/alarms/:id/acknowledge` - Acknowledge alarm
- `POST /api/alarms/:id/resolve` - Resolve alarm

#### Reports
- `GET /api/reports` - List reports
- `POST /api/reports/generate` - Generate new report

#### Dashboard
- `GET /api/dashboard/stats` - Dashboard statistics
- `GET /api/dashboard/consumption-chart` - Consumption trend

See `backend/src/routes/` for complete API documentation.

## Support & Resources

- **Documentation**: See `/docs/` folder
- **Database Schema**: `database/schema.sql`
- **Configuration**: `.env.example`
- **Issues**: Check logs with `docker-compose logs`

## License

NUWACO WMS - All Rights Reserved
