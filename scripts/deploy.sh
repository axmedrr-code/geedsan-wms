#!/bin/bash

# GEEDSAN WMS - Production Deployment Script
# This script initializes a fresh GEEDSAN deployment

set -e

echo "🚀 GEEDSAN WMS - Production Initialization Script"
echo "=================================================="

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed"
  exit 1
fi

echo "✅ Docker is installed: $(docker --version)"

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p backend/uploads backend/reports backend/logs frontend/public docker/ssl

# Generate JWT secrets if not already set
echo "🔐 Configuring JWT secrets..."
if ! grep -q "JWT_SECRET=" .env; then
  JWT_SECRET=$(openssl rand -base64 32)
  JWT_REFRESH_SECRET=$(openssl rand -base64 32)
  
  # Update or create .env if needed
  if [ ! -f .env ]; then
    cp .env.example .env
  fi
  
  # Update secrets (only if they contain placeholder values)
  sed -i "s/geedsan-jwt-secret-change-this-in-production-2024/$JWT_SECRET/g" .env
  sed -i "s/geedsan-refresh-secret-change-this-in-production-2024/$JWT_REFRESH_SECRET/g" .env
  
  echo "✅ JWT secrets generated and saved to .env"
else
  echo "✅ JWT secrets already configured in .env"
fi

# Build and start services
echo "🐳 Building Docker images..."
docker-compose build

echo "🚀 Starting services..."
docker-compose up -d

# Wait for database to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
RETRY=30
while [ $RETRY -gt 0 ]; do
  if docker exec geedsan-postgres pg_isready -U geedsan > /dev/null 2>&1; then
    echo "✅ PostgreSQL is ready"
    break
  fi
  echo "⏳ Waiting... ($RETRY attempts left)"
  RETRY=$((RETRY - 1))
  sleep 2
done

if [ $RETRY -eq 0 ]; then
  echo "❌ PostgreSQL failed to start"
  exit 1
fi

# Run seed script
echo "🌱 Seeding database..."
if docker-compose exec -T backend npm run seed > /dev/null 2>&1; then
  echo "✅ Database seeded successfully"
  echo ""
  echo "📝 Demo Accounts:"
  echo "   Admin:    admin / Admin@Geedsan2024"
  echo "   Operator: operator1 / Operator@2024"
  echo "   Viewer:   viewer1 / Viewer@2024"
else
  echo "⚠️  Seed script encountered issues (this might be normal if database already has data)"
fi

# Health checks
echo ""
echo "🏥 Checking service health..."
sleep 3

BACKEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/health)
if [ "$BACKEND_STATUS" = "200" ]; then
  echo "✅ Backend API: Healthy"
else
  echo "❌ Backend API: Unhealthy (HTTP $BACKEND_STATUS)"
fi

FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
if [ "$FRONTEND_STATUS" = "200" ] || [ "$FRONTEND_STATUS" = "307" ]; then
  echo "✅ Frontend: Healthy"
else
  echo "❌ Frontend: Unhealthy (HTTP $FRONTEND_STATUS)"
fi

# Summary
echo ""
echo "✅ DEPLOYMENT COMPLETE!"
echo ""
echo "🌐 Access the system:"
echo "   Frontend:    http://localhost:3000"
echo "   API:         http://localhost:5000/api"
echo "   Database:    localhost:5432 (geedsan/GeedSan@Secure2024)"
echo "   MQTT:        localhost:1883"
echo ""
echo "📚 Commands:"
echo "   View logs:   docker-compose logs -f"
echo "   Stop:        docker-compose down"
echo "   Restart:     docker-compose restart"
echo ""
