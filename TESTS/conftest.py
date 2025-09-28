"""Test configuration and fixtures for TaskFlow API tests."""

import pytest
import tempfile
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

# Import the actual modules now that they exist
from SRC.database.models import Base
from SRC.database.connection import get_db
# from SRC.api.main import app  # Will be uncommented when API is created


@pytest.fixture(scope="function")
def test_db():
    """Create a temporary test database."""
    # Use in-memory SQLite database for tests
    engine = create_engine("sqlite:///:memory:", echo=False)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    
    yield TestingSessionLocal, engine
    
    # Cleanup happens automatically with in-memory database


@pytest.fixture
def db_session(test_db):
    """Create a database session for testing."""
    TestingSessionLocal, engine = test_db
    
    # Create tables
    Base.metadata.create_all(bind=engine)
    
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client(db_session):
    """Create a test client with database dependency override."""
    # This will be implemented once we have the app
    # def override_get_db():
    #     try:
    #         yield db_session
    #     finally:
    #         pass
    # 
    # app.dependency_overrides[get_db] = override_get_db
    # 
    # with TestClient(app) as test_client:
    #     yield test_client
    # 
    # app.dependency_overrides.clear()
    pass


@pytest.fixture
def sample_user_data():
    """Sample user data for testing."""
    return {
        "email": "test@example.com",
        "password": "testpassword123"
    }


@pytest.fixture
def sample_task_data():
    """Sample task data for testing."""
    return {
        "title": "Test Task",
        "description": "This is a test task",
        "status": "pending",
        "priority": "medium",
        "due_date": "2025-12-31T23:59:59"
    }


@pytest.fixture
def auth_headers():
    """Sample auth headers for testing."""
    return {
        "Authorization": "Bearer test_jwt_token"
    }
