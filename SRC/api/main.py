"""FastAPI main application for TaskFlow API."""

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from ..database.connection import get_db, init_db
from ..auth.service import validate_token
from ..shared.exceptions import (
    UserExistsError, AuthenticationError, TokenExpiredError, 
    InvalidTokenError, TaskNotFoundError, UnauthorizedError, ValidationError
)
from .auth_routes import router as auth_router

# Create FastAPI application
app = FastAPI(
    title="TaskFlow API",
    description="A comprehensive task management API with user authentication",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security scheme
security = HTTPBearer()

# Include routers
app.include_router(auth_router, prefix="/auth", tags=["Authentication"])

# Import and configure task router after get_current_user is defined
from .task_routes import router as task_router
app.include_router(task_router, prefix="/tasks", tags=["Tasks"])


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup."""
    init_db()


@app.get("/", tags=["Health"])
async def root():
    """Root endpoint - API health check."""
    return {
        "message": "TaskFlow API is running",
        "version": "1.0.0",
        "status": "healthy",
        "docs": "/docs"
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint for monitoring."""
    return {
        "status": "healthy",
        "timestamp": "2025-09-28T09:43:00Z",
        "version": "1.0.0"
    }


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    """Get current authenticated user from JWT token."""
    try:
        token = credentials.credentials
        user = validate_token(token, db)
        return user
    except TokenExpiredError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


# Global exception handlers
@app.exception_handler(UserExistsError)
async def user_exists_handler(request, exc):
    return HTTPException(status_code=409, detail=str(exc))


@app.exception_handler(AuthenticationError)
async def auth_error_handler(request, exc):
    return HTTPException(status_code=401, detail=str(exc))


@app.exception_handler(ValidationError)
async def validation_error_handler(request, exc):
    return HTTPException(status_code=422, detail=str(exc))


@app.exception_handler(TaskNotFoundError)
async def task_not_found_handler(request, exc):
    return HTTPException(status_code=404, detail=str(exc))


@app.exception_handler(UnauthorizedError)
async def unauthorized_handler(request, exc):
    return HTTPException(status_code=403, detail=str(exc))
