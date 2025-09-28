#!/bin/bash
set -e

echo "🔧 Installing Python dependencies..."
pip install -r requirements.txt

echo "🎨 Building React frontend..."
cd frontend
npm ci
npm run build
cd ..

echo "✅ Build completed successfully!"