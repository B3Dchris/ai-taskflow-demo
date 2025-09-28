"""Integration tests for TaskFlow API endpoints."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import tempfile
import os

from SRC.api.main import app
from SRC.database.models import Base
from SRC.database.connection import get_db


@pytest.fixture(scope="function")  # Changed from module to function scope
def test_client():
    """Create a test client with in-memory database."""
    # Create in-memory database for integration tests with thread safety
    engine = create_engine(
        "sqlite:///:memory:", 
        echo=False,
        connect_args={"check_same_thread": False}
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    
    # Create tables
    Base.metadata.create_all(bind=engine)
    
    # Override database dependency
    def override_get_db():
        try:
            db = TestingSessionLocal()
            yield db
        finally:
            db.close()
    
    # Clear any existing overrides first
    app.dependency_overrides.clear()
    app.dependency_overrides[get_db] = override_get_db
    
    # Create test client
    with TestClient(app) as client:
        yield client
    
    # Cleanup
    app.dependency_overrides.clear()


@pytest.mark.integration
class TestCompleteUserJourney:
    """Test the complete user journey from registration to task management."""
    
    def test_complete_user_workflow(self, test_client):
        """Test complete user workflow: register → login → create tasks → manage tasks."""
        
        # Step 1: User Registration
        registration_data = {
            "email": "testuser@example.com",
            "password": "securepassword123"
        }
        
        response = test_client.post("/auth/register", json=registration_data)
        assert response.status_code == 201
        user_data = response.json()
        assert user_data["email"] == "testuser@example.com"
        assert "id" in user_data
        assert "password" not in user_data  # Security: password not returned
        
        # Step 2: User Login
        login_data = {
            "email": "testuser@example.com",
            "password": "securepassword123"
        }
        
        response = test_client.post("/auth/login", json=login_data)
        assert response.status_code == 200
        token_data = response.json()
        assert "access_token" in token_data
        assert token_data["token_type"] == "bearer"
        
        # Extract token for authenticated requests
        token = token_data["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Step 3: Create Tasks
        task1_data = {
            "title": "Complete project proposal",
            "description": "Write and submit the Q4 project proposal",
            "priority": "high",
            "status": "pending"
        }
        
        response = test_client.post("/tasks/", json=task1_data, headers=headers)
        assert response.status_code == 201
        task1 = response.json()
        assert task1["title"] == "Complete project proposal"
        assert task1["priority"] == "high"
        assert task1["status"] == "pending"
        assert "id" in task1
        
        # Create second task
        task2_data = {
            "title": "Review team performance",
            "description": "Conduct quarterly team reviews",
            "priority": "medium",
            "status": "in_progress"
        }
        
        response = test_client.post("/tasks/", json=task2_data, headers=headers)
        assert response.status_code == 201
        task2 = response.json()
        
        # Step 4: List All Tasks
        response = test_client.get("/tasks/", headers=headers)
        assert response.status_code == 200
        tasks = response.json()
        assert len(tasks) == 2
        
        # Verify both tasks are returned
        task_titles = [task["title"] for task in tasks]
        assert "Complete project proposal" in task_titles
        assert "Review team performance" in task_titles
        
        # Step 5: Filter Tasks by Status
        response = test_client.get("/tasks/?status=pending", headers=headers)
        assert response.status_code == 200
        pending_tasks = response.json()
        assert len(pending_tasks) == 1
        assert pending_tasks[0]["title"] == "Complete project proposal"
        
        # Step 6: Get Specific Task
        task1_id = task1["id"]
        response = test_client.get(f"/tasks/{task1_id}", headers=headers)
        assert response.status_code == 200
        retrieved_task = response.json()
        assert retrieved_task["title"] == "Complete project proposal"
        
        # Step 7: Update Task
        update_data = {
            "status": "completed",
            "description": "Project proposal completed and submitted successfully"
        }
        
        response = test_client.put(f"/tasks/{task1_id}", json=update_data, headers=headers)
        assert response.status_code == 200
        updated_task = response.json()
        assert updated_task["status"] == "completed"
        assert "completed and submitted successfully" in updated_task["description"]
        
        # Step 8: Search Tasks
        response = test_client.get("/tasks/?search=project", headers=headers)
        assert response.status_code == 200
        search_results = response.json()
        assert len(search_results) == 1
        assert "project" in search_results[0]["title"].lower()
        
        # Step 9: Update Task Status (Quick Update)
        task2_id = task2["id"]
        response = test_client.patch(f"/tasks/{task2_id}/status", json="completed", headers=headers)
        assert response.status_code == 200
        status_updated_task = response.json()
        assert status_updated_task["status"] == "completed"
        
        # Step 10: Delete Task
        response = test_client.delete(f"/tasks/{task2_id}", headers=headers)
        assert response.status_code == 204
        
        # Verify task is deleted
        response = test_client.get(f"/tasks/{task2_id}", headers=headers)
        assert response.status_code == 404
        
        # Final verification: Only one task remains
        response = test_client.get("/tasks/", headers=headers)
        assert response.status_code == 200
        final_tasks = response.json()
        assert len(final_tasks) == 1
        assert final_tasks[0]["title"] == "Complete project proposal"


@pytest.mark.integration
class TestSecurityBoundaries:
    """Test security boundaries and authorization."""
    
    def test_user_data_isolation(self, test_client):
        """Test that users can only access their own data."""
        
        # Create two users
        user1_data = {"email": "user1@example.com", "password": "password123"}
        user2_data = {"email": "user2@example.com", "password": "password123"}
        
        # Register both users
        test_client.post("/auth/register", json=user1_data)
        test_client.post("/auth/register", json=user2_data)
        
        # Login both users
        token1_response = test_client.post("/auth/login", json=user1_data)
        token2_response = test_client.post("/auth/login", json=user2_data)
        
        token1 = token1_response.json()["access_token"]
        token2 = token2_response.json()["access_token"]
        
        headers1 = {"Authorization": f"Bearer {token1}"}
        headers2 = {"Authorization": f"Bearer {token2}"}
        
        # User 1 creates a task
        task_data = {"title": "User 1's private task", "description": "Confidential information"}
        response = test_client.post("/tasks/", json=task_data, headers=headers1)
        task = response.json()
        task_id = task["id"]
        
        # User 2 should not be able to access User 1's task
        response = test_client.get(f"/tasks/{task_id}", headers=headers2)
        assert response.status_code == 403  # Forbidden
        
        # User 2 should not be able to update User 1's task
        update_data = {"title": "Hacked task"}
        response = test_client.put(f"/tasks/{task_id}", json=update_data, headers=headers2)
        assert response.status_code == 403  # Forbidden
        
        # User 2 should not be able to delete User 1's task
        response = test_client.delete(f"/tasks/{task_id}", headers=headers2)
        assert response.status_code == 403  # Forbidden
        
        # User 2 should not see User 1's tasks in their list
        response = test_client.get("/tasks/", headers=headers2)
        assert response.status_code == 200
        user2_tasks = response.json()
        assert len(user2_tasks) == 0  # No tasks for user 2
        
        # User 1 should still be able to access their own task
        response = test_client.get(f"/tasks/{task_id}", headers=headers1)
        assert response.status_code == 200
        retrieved_task = response.json()
        assert retrieved_task["title"] == "User 1's private task"
    
    def test_authentication_required(self, test_client):
        """Test that protected endpoints require authentication."""
        
        # Try to access protected endpoints without token
        response = test_client.get("/tasks/")
        assert response.status_code == 403  # Forbidden (no auth header)
        
        response = test_client.post("/tasks/", json={"title": "Test task"})
        assert response.status_code == 403  # Forbidden
        
        response = test_client.get("/tasks/1")
        assert response.status_code == 403  # Forbidden
        
        # Try with invalid token
        invalid_headers = {"Authorization": "Bearer invalid_token"}
        response = test_client.get("/tasks/", headers=invalid_headers)
        assert response.status_code == 401  # Unauthorized
    
    def test_duplicate_user_registration(self, test_client):
        """Test that duplicate email registration is prevented."""
        
        user_data = {"email": "duplicate@example.com", "password": "password123"}
        
        # First registration should succeed
        response = test_client.post("/auth/register", json=user_data)
        assert response.status_code == 201
        
        # Second registration with same email should fail
        response = test_client.post("/auth/register", json=user_data)
        assert response.status_code == 409  # Conflict
        assert "already exists" in response.json()["detail"].lower()


@pytest.mark.integration
class TestErrorHandling:
    """Test error handling and edge cases."""
    
    def test_invalid_login_credentials(self, test_client):
        """Test login with invalid credentials."""
        
        # Register a user
        user_data = {"email": "valid@example.com", "password": "correctpassword"}
        test_client.post("/auth/register", json=user_data)
        
        # Try login with wrong password
        wrong_password = {"email": "valid@example.com", "password": "wrongpassword"}
        response = test_client.post("/auth/login", json=wrong_password)
        assert response.status_code == 401
        
        # Try login with non-existent email
        wrong_email = {"email": "nonexistent@example.com", "password": "correctpassword"}
        response = test_client.post("/auth/login", json=wrong_email)
        assert response.status_code == 401
    
    def test_invalid_task_data(self, test_client):
        """Test task creation with invalid data."""
        
        # Register and login user
        user_data = {"email": "tasktest@example.com", "password": "password123"}
        test_client.post("/auth/register", json=user_data)
        token_response = test_client.post("/auth/login", json=user_data)
        token = token_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Try to create task without title
        invalid_task = {"description": "Task without title"}
        response = test_client.post("/tasks/", json=invalid_task, headers=headers)
        assert response.status_code == 422  # Validation error
        
        # Try to create task with title too long
        long_title_task = {"title": "x" * 201}  # Exceeds 200 char limit
        response = test_client.post("/tasks/", json=long_title_task, headers=headers)
        assert response.status_code == 422  # Validation error
    
    def test_nonexistent_task_operations(self, test_client):
        """Test operations on non-existent tasks."""
        
        # Register and login user
        user_data = {"email": "notfound@example.com", "password": "password123"}
        test_client.post("/auth/register", json=user_data)
        token_response = test_client.post("/auth/login", json=user_data)
        token = token_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Try to get non-existent task
        response = test_client.get("/tasks/99999", headers=headers)
        assert response.status_code == 404
        
        # Try to update non-existent task
        update_data = {"title": "Updated title"}
        response = test_client.put("/tasks/99999", json=update_data, headers=headers)
        assert response.status_code == 404
        
        # Try to delete non-existent task
        response = test_client.delete("/tasks/99999", headers=headers)
        assert response.status_code == 404


@pytest.mark.integration
class TestHealthAndMonitoring:
    """Test health check and monitoring endpoints."""
    
    def test_health_endpoints(self, test_client):
        """Test health check endpoints."""
        
        # Test root endpoint
        response = test_client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "TaskFlow API" in data["message"]
        
        # Test health endpoint
        response = test_client.get("/health")
        assert response.status_code == 200
        health_data = response.json()
        assert health_data["status"] == "healthy"
        assert "version" in health_data
    
    def test_api_documentation(self, test_client):
        """Test that API documentation is accessible."""
        
        # Test OpenAPI schema
        response = test_client.get("/openapi.json")
        assert response.status_code == 200
        openapi_data = response.json()
        assert openapi_data["info"]["title"] == "TaskFlow API"
        
        # Verify key endpoints are documented
        paths = openapi_data["paths"]
        assert "/auth/register" in paths
        assert "/auth/login" in paths
        assert "/tasks/" in paths
        assert "/health" in paths
