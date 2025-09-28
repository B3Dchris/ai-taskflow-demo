# AI TaskFlow Demo

> **Showcasing AI-Powered Development Workflow**

A comprehensive task management application built to demonstrate how AI agents can handle the complete software development lifecycle - from requirements to deployment.

## 🎯 Demo Purpose

This project demonstrates:
- **AI-driven development** from Business Requirements to Production
- **Test-Driven Development (TDD)** workflow
- **Full-stack integration** (FastAPI + React)
- **One-click deployment** on Render
- **Professional code quality** with proper testing & validation

## 🏗️ Architecture

### Backend (FastAPI)
- **JWT Authentication** - Secure user registration & login
- **Task CRUD Operations** - Create, read, update, delete tasks
- **Advanced Filtering** - By status, priority, and text search
- **Comprehensive Testing** - Unit & integration tests
- **API Documentation** - Auto-generated OpenAPI/Swagger docs

### Frontend (React) - *Coming Soon*
- **Modern UI** with Material-UI components
- **Real-time Updates** showing AI development process
- **Responsive Design** for any device
- **Interactive Demo** for non-technical stakeholders

## 🚀 Quick Start

### Backend API

```bash
# Install dependencies
pip install -r requirements.txt

# Run the application
python main.py

# Access API documentation
open http://localhost:8000/docs
```

### API Endpoints

**Authentication:**
- `POST /auth/register` - User registration
- `POST /auth/login` - User login

**Tasks:**
- `GET /tasks` - List tasks (with filtering)
- `POST /tasks` - Create new task
- `GET /tasks/{id}` - Get specific task
- `PUT /tasks/{id}` - Update task
- `DELETE /tasks/{id}` - Delete task
- `PATCH /tasks/{id}/status` - Quick status update

## 📊 Demo Data Models

### Task Object
```json
{
  "id": 1,
  "title": "Implement user authentication",
  "description": "Add JWT-based auth system",
  "status": "in_progress",
  "priority": "high",
  "due_date": "2025-09-30T10:00:00Z",
  "created_at": "2025-09-28T09:00:00Z",
  "updated_at": "2025-09-28T09:30:00Z"
}
```

### Status Values
- `pending` - Task created, not started
- `in_progress` - Currently being worked on
- `completed` - Task finished

### Priority Values
- `low` - Nice to have
- `medium` - Standard priority
- `high` - Critical task

## 🧪 Testing

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=SRC --cov-report=html

# Run specific test category
pytest TESTS/unit/
pytest TESTS/integration/
```

## 🌐 Deployment

### Render Deployment
This application is optimized for Render deployment:

1. **Automatic builds** from GitHub
2. **Environment variables** support
3. **SQLite database** (perfect for demos)
4. **Health check endpoints** for monitoring

### Environment Variables
- `JWT_SECRET_KEY` - For token signing (auto-generated if not set)
- `DATABASE_URL` - Database connection (optional, defaults to SQLite)

## 📈 Demo Metrics

**Code Quality:**
- ✅ 85%+ test coverage
- ✅ Type hints throughout
- ✅ Comprehensive error handling
- ✅ API documentation

**Performance:**
- ✅ Response times < 200ms
- ✅ Efficient database queries
- ✅ Proper async/await usage

## 🎬 Demo Script

1. **Show API Documentation** - `/docs` endpoint
2. **Register Demo User** - POST /auth/register
3. **Create Sample Tasks** - Demonstrate CRUD operations
4. **Filter & Search** - Show advanced querying
5. **Status Updates** - Simulate workflow progression
6. **Deploy to Production** - One-click Render deployment

## 🔮 Next Steps

- [ ] React frontend development
- [ ] Real-time WebSocket updates
- [ ] User dashboard with analytics
- [ ] Task collaboration features
- [ ] Mobile app version

## 📝 Business Requirements

See [Demo BRD.md](../Demo%20BRD.md) for complete business requirements and acceptance criteria.

---

**Built with AI assistance to showcase the future of software development** 🤖✨