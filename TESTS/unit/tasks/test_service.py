"""Unit tests for task service."""

import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock

# These imports will fail initially - that's the point of TDD!
try:
    from SRC.tasks.service import (
        create_task, get_user_tasks, get_task_by_id, 
        update_task, delete_task, search_tasks
    )
    from SRC.tasks.schemas import TaskCreate, TaskUpdate, TaskResponse
    from SRC.database.models import User, Task, TaskStatus, TaskPriority
    from SRC.shared.exceptions import (
        TaskNotFoundError, UnauthorizedError, ValidationError, UserNotFoundError
    )
except ImportError:
    # Expected to fail initially
    create_task = None
    get_user_tasks = None
    get_task_by_id = None
    update_task = None
    delete_task = None
    search_tasks = None
    TaskCreate = None
    TaskUpdate = None
    TaskResponse = None
    User = None
    Task = None
    TaskStatus = None
    TaskPriority = None
    TaskNotFoundError = None
    UnauthorizedError = None
    ValidationError = None
    UserNotFoundError = None


@pytest.fixture
def sample_user(db_session):
    """Create a sample user for testing."""
    if User is None:
        pytest.skip("User model not available")
    
    user = User(email="testuser@example.com", password_hash="hashed_password")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def another_user(db_session):
    """Create another user for authorization testing."""
    if User is None:
        pytest.skip("User model not available")
    
    user = User(email="otheruser@example.com", password_hash="hashed_password")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def sample_task_data():
    """Sample task data for testing."""
    return {
        "title": "Test Task",
        "description": "This is a test task",
        "status": "pending",
        "priority": "medium",
        "due_date": datetime.now() + timedelta(days=7)
    }


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(create_task is None, reason="Task service not implemented yet")
class TestCreateTask:
    """Test cases for task creation."""
    
    def test_create_task_success(self, db_session, sample_user, sample_task_data):
        """Test successful task creation with valid data."""
        # Happy path test
        task = create_task(sample_user.id, sample_task_data, db_session)
        
        assert task.id is not None
        assert task.user_id == sample_user.id
        assert task.title == sample_task_data["title"]
        assert task.description == sample_task_data["description"]
        assert task.status == TaskStatus.PENDING
        assert task.priority == TaskPriority.MEDIUM
        assert task.created_at is not None
        assert task.updated_at is not None
    
    def test_create_task_minimal_data(self, db_session, sample_user):
        """Test task creation with minimal required data (edge case)."""
        minimal_data = {
            "title": "Minimal Task"
        }
        
        task = create_task(sample_user.id, minimal_data, db_session)
        
        assert task.title == "Minimal Task"
        assert task.description is None
        assert task.status == TaskStatus.PENDING  # Default
        assert task.priority == TaskPriority.MEDIUM  # Default
        assert task.due_date is None
    
    def test_create_task_with_due_date(self, db_session, sample_user):
        """Test task creation with due date (edge case)."""
        due_date = datetime.now() + timedelta(days=30)
        task_data = {
            "title": "Task with due date",
            "due_date": due_date
        }
        
        task = create_task(sample_user.id, task_data, db_session)
        
        assert task.due_date == due_date
    
    def test_create_task_invalid_user(self, db_session, sample_task_data):
        """Test task creation fails with invalid user ID (negative case)."""
        with pytest.raises(UserNotFoundError):
            create_task(99999, sample_task_data, db_session)
    
    def test_create_task_empty_title(self, db_session, sample_user):
        """Test task creation fails with empty title (negative case)."""
        invalid_data = {
            "title": "",
            "description": "Task without title"
        }
        
        with pytest.raises(ValidationError):
            create_task(sample_user.id, invalid_data, db_session)
    
    def test_create_task_title_too_long(self, db_session, sample_user):
        """Test task creation fails with title too long (negative case)."""
        invalid_data = {
            "title": "x" * 201,  # Exceeds 200 char limit
            "description": "Task with very long title"
        }
        
        with pytest.raises(ValidationError):
            create_task(sample_user.id, invalid_data, db_session)


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(get_user_tasks is None, reason="Task service not implemented yet")
class TestGetUserTasks:
    """Test cases for retrieving user tasks."""
    
    def test_get_user_tasks_empty(self, db_session, sample_user):
        """Test getting tasks for user with no tasks."""
        tasks = get_user_tasks(sample_user.id, db_session)
        
        assert tasks == []
    
    def test_get_user_tasks_multiple(self, db_session, sample_user):
        """Test getting multiple tasks for user (happy path)."""
        # Create multiple tasks
        task1 = Task(user_id=sample_user.id, title="Task 1", status=TaskStatus.PENDING)
        task2 = Task(user_id=sample_user.id, title="Task 2", status=TaskStatus.COMPLETED)
        task3 = Task(user_id=sample_user.id, title="Task 3", status=TaskStatus.IN_PROGRESS)
        
        db_session.add_all([task1, task2, task3])
        db_session.commit()
        
        tasks = get_user_tasks(sample_user.id, db_session)
        
        assert len(tasks) == 3
        task_titles = [task.title for task in tasks]
        assert "Task 1" in task_titles
        assert "Task 2" in task_titles
        assert "Task 3" in task_titles
    
    def test_get_user_tasks_filter_by_status(self, db_session, sample_user):
        """Test filtering tasks by status (edge case)."""
        # Create tasks with different statuses
        task1 = Task(user_id=sample_user.id, title="Pending Task", status=TaskStatus.PENDING)
        task2 = Task(user_id=sample_user.id, title="Completed Task", status=TaskStatus.COMPLETED)
        
        db_session.add_all([task1, task2])
        db_session.commit()
        
        # Filter by pending status
        pending_tasks = get_user_tasks(sample_user.id, db_session, status="pending")
        assert len(pending_tasks) == 1
        assert pending_tasks[0].title == "Pending Task"
        
        # Filter by completed status
        completed_tasks = get_user_tasks(sample_user.id, db_session, status="completed")
        assert len(completed_tasks) == 1
        assert completed_tasks[0].title == "Completed Task"
    
    def test_get_user_tasks_filter_by_priority(self, db_session, sample_user):
        """Test filtering tasks by priority (edge case)."""
        # Create tasks with different priorities
        task1 = Task(user_id=sample_user.id, title="High Priority", priority=TaskPriority.HIGH)
        task2 = Task(user_id=sample_user.id, title="Low Priority", priority=TaskPriority.LOW)
        
        db_session.add_all([task1, task2])
        db_session.commit()
        
        # Filter by high priority
        high_tasks = get_user_tasks(sample_user.id, db_session, priority="high")
        assert len(high_tasks) == 1
        assert high_tasks[0].title == "High Priority"
    
    def test_get_user_tasks_isolation(self, db_session, sample_user, another_user):
        """Test that users only see their own tasks (security test)."""
        # Create tasks for different users
        user1_task = Task(user_id=sample_user.id, title="User 1 Task")
        user2_task = Task(user_id=another_user.id, title="User 2 Task")
        
        db_session.add_all([user1_task, user2_task])
        db_session.commit()
        
        # Each user should only see their own tasks
        user1_tasks = get_user_tasks(sample_user.id, db_session)
        user2_tasks = get_user_tasks(another_user.id, db_session)
        
        assert len(user1_tasks) == 1
        assert user1_tasks[0].title == "User 1 Task"
        
        assert len(user2_tasks) == 1
        assert user2_tasks[0].title == "User 2 Task"


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(get_task_by_id is None, reason="Task service not implemented yet")
class TestGetTaskById:
    """Test cases for getting specific task by ID."""
    
    def test_get_task_by_id_success(self, db_session, sample_user):
        """Test successful task retrieval by ID."""
        # Create a task
        task = Task(user_id=sample_user.id, title="Test Task")
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Retrieve by ID
        retrieved_task = get_task_by_id(task.id, sample_user.id, db_session)
        
        assert retrieved_task.id == task.id
        assert retrieved_task.title == "Test Task"
        assert retrieved_task.user_id == sample_user.id
    
    def test_get_task_by_id_not_found(self, db_session, sample_user):
        """Test task retrieval with non-existent ID (edge case)."""
        with pytest.raises(TaskNotFoundError):
            get_task_by_id(99999, sample_user.id, db_session)
    
    def test_get_task_by_id_unauthorized(self, db_session, sample_user, another_user):
        """Test task retrieval by wrong user (security test)."""
        # Create task for one user
        task = Task(user_id=sample_user.id, title="Private Task")
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Try to access with different user
        with pytest.raises(UnauthorizedError):
            get_task_by_id(task.id, another_user.id, db_session)


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(update_task is None, reason="Task service not implemented yet")
class TestUpdateTask:
    """Test cases for task updates."""
    
    def test_update_task_success(self, db_session, sample_user):
        """Test successful task update."""
        # Create a task
        task = Task(user_id=sample_user.id, title="Original Title", status=TaskStatus.PENDING)
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Update the task
        updates = {
            "title": "Updated Title",
            "status": "completed",
            "description": "Added description"
        }
        
        updated_task = update_task(task.id, sample_user.id, updates, db_session)
        
        assert updated_task.title == "Updated Title"
        assert updated_task.status == TaskStatus.COMPLETED
        assert updated_task.description == "Added description"
        assert updated_task.updated_at >= updated_task.created_at  # Allow equal timestamps
    
    def test_update_task_partial(self, db_session, sample_user):
        """Test partial task update (edge case)."""
        # Create a task
        task = Task(
            user_id=sample_user.id, 
            title="Original Title",
            description="Original Description",
            status=TaskStatus.PENDING
        )
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Update only title
        updates = {"title": "New Title Only"}
        
        updated_task = update_task(task.id, sample_user.id, updates, db_session)
        
        assert updated_task.title == "New Title Only"
        assert updated_task.description == "Original Description"  # Unchanged
        assert updated_task.status == TaskStatus.PENDING  # Unchanged
    
    def test_update_task_not_found(self, db_session, sample_user):
        """Test update of non-existent task (negative case)."""
        updates = {"title": "New Title"}
        
        with pytest.raises(TaskNotFoundError):
            update_task(99999, sample_user.id, updates, db_session)
    
    def test_update_task_unauthorized(self, db_session, sample_user, another_user):
        """Test update by wrong user (security test)."""
        # Create task for one user
        task = Task(user_id=sample_user.id, title="Private Task")
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Try to update with different user
        updates = {"title": "Hacked Title"}
        
        with pytest.raises(UnauthorizedError):
            update_task(task.id, another_user.id, updates, db_session)


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(delete_task is None, reason="Task service not implemented yet")
class TestDeleteTask:
    """Test cases for task deletion."""
    
    def test_delete_task_success(self, db_session, sample_user):
        """Test successful task deletion."""
        # Create a task
        task = Task(user_id=sample_user.id, title="Task to Delete")
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        task_id = task.id
        
        # Delete the task
        result = delete_task(task_id, sample_user.id, db_session)
        
        assert result is True
        
        # Verify task is deleted
        deleted_task = db_session.query(Task).filter(Task.id == task_id).first()
        assert deleted_task is None
    
    def test_delete_task_not_found(self, db_session, sample_user):
        """Test deletion of non-existent task (negative case)."""
        with pytest.raises(TaskNotFoundError):
            delete_task(99999, sample_user.id, db_session)
    
    def test_delete_task_unauthorized(self, db_session, sample_user, another_user):
        """Test deletion by wrong user (security test)."""
        # Create task for one user
        task = Task(user_id=sample_user.id, title="Private Task")
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        
        # Try to delete with different user
        with pytest.raises(UnauthorizedError):
            delete_task(task.id, another_user.id, db_session)


@pytest.mark.unit
@pytest.mark.tasks
@pytest.mark.skipif(search_tasks is None, reason="Task service not implemented yet")
class TestSearchTasks:
    """Test cases for task search functionality."""
    
    def test_search_tasks_by_title(self, db_session, sample_user):
        """Test searching tasks by title."""
        # Create tasks with different titles
        task1 = Task(user_id=sample_user.id, title="Python Development")
        task2 = Task(user_id=sample_user.id, title="JavaScript Testing")
        task3 = Task(user_id=sample_user.id, title="Database Migration")
        
        db_session.add_all([task1, task2, task3])
        db_session.commit()
        
        # Search for "Python"
        results = search_tasks(sample_user.id, "Python", db_session)
        
        assert len(results) == 1
        assert results[0].title == "Python Development"
    
    def test_search_tasks_by_description(self, db_session, sample_user):
        """Test searching tasks by description (edge case)."""
        # Create tasks with different descriptions
        task1 = Task(
            user_id=sample_user.id, 
            title="Task 1",
            description="Work on API endpoints"
        )
        task2 = Task(
            user_id=sample_user.id,
            title="Task 2", 
            description="Update database schema"
        )
        
        db_session.add_all([task1, task2])
        db_session.commit()
        
        # Search for "API"
        results = search_tasks(sample_user.id, "API", db_session)
        
        assert len(results) == 1
        assert results[0].description == "Work on API endpoints"
    
    def test_search_tasks_case_insensitive(self, db_session, sample_user):
        """Test case-insensitive search (edge case)."""
        task = Task(user_id=sample_user.id, title="URGENT Task")
        db_session.add(task)
        db_session.commit()
        
        # Search with lowercase
        results = search_tasks(sample_user.id, "urgent", db_session)
        
        assert len(results) == 1
        assert results[0].title == "URGENT Task"
    
    def test_search_tasks_no_results(self, db_session, sample_user):
        """Test search with no matching results (negative case)."""
        task = Task(user_id=sample_user.id, title="Regular Task")
        db_session.add(task)
        db_session.commit()
        
        # Search for non-existent term
        results = search_tasks(sample_user.id, "nonexistent", db_session)
        
        assert results == []
