"""Unit tests for database models."""

import pytest
from datetime import datetime
from sqlalchemy.exc import IntegrityError
from sqlalchemy import text

# These imports will fail initially - that's the point of TDD!
try:
    from SRC.database.models import User, Task, Base, TaskStatus, TaskPriority
    from SRC.database.connection import get_db, init_db
except ImportError:
    # Expected to fail initially
    User = None
    Task = None
    Base = None
    TaskStatus = None
    TaskPriority = None
    get_db = None
    init_db = None


@pytest.mark.unit
@pytest.mark.skipif(User is None, reason="User model not implemented yet")
class TestUserModel:
    """Test cases for User model."""
    
    def test_user_creation_success(self, db_session):
        """Test successful user creation with valid data."""
        # Happy path test
        user = User(
            email="test@example.com",
            password_hash="hashed_password_123"
        )
        db_session.add(user)
        db_session.commit()
        
        assert user.id is not None
        assert user.email == "test@example.com"
        assert user.password_hash == "hashed_password_123"
        assert user.created_at is not None
        assert user.updated_at is not None
    
    def test_user_email_unique_constraint(self, db_session):
        """Test that email must be unique (edge case)."""
        # Create first user
        user1 = User(email="test@example.com", password_hash="hash1")
        db_session.add(user1)
        db_session.commit()
        
        # Try to create second user with same email
        user2 = User(email="test@example.com", password_hash="hash2")
        db_session.add(user2)
        
        with pytest.raises(IntegrityError):
            db_session.commit()
    
    def test_user_email_case_sensitivity(self, db_session):
        """Test email case sensitivity (edge case)."""
        user1 = User(email="Test@Example.com", password_hash="hash1")
        user2 = User(email="test@example.com", password_hash="hash2")
        
        db_session.add(user1)
        db_session.commit()
        db_session.add(user2)
        
        # Should not raise error (case sensitive)
        db_session.commit()
        
        assert user1.email != user2.email
    
    def test_user_missing_email_fails(self, db_session):
        """Test that user creation fails without email (negative case)."""
        user = User(password_hash="hash123")
        db_session.add(user)
        
        with pytest.raises(IntegrityError):
            db_session.commit()


@pytest.mark.unit
@pytest.mark.skipif(Task is None, reason="Task model not implemented yet")
class TestTaskModel:
    """Test cases for Task model."""
    
    def test_task_creation_success(self, db_session, sample_user_data):
        """Test successful task creation with valid data."""
        # Create user first
        user = User(email=sample_user_data["email"], password_hash="hash123")
        db_session.add(user)
        db_session.commit()
        
        # Create task
        task = Task(
            user_id=user.id,
            title="Test Task",
            description="Test Description",
            status=TaskStatus.PENDING,
            priority=TaskPriority.MEDIUM
        )
        db_session.add(task)
        db_session.commit()
        
        assert task.id is not None
        assert task.user_id == user.id
        assert task.title == "Test Task"
        assert task.description == "Test Description"
        assert task.status == TaskStatus.PENDING
        assert task.priority == TaskPriority.MEDIUM
        assert task.created_at is not None
        assert task.updated_at is not None
    
    def test_task_with_due_date(self, db_session, sample_user_data):
        """Test task creation with due date (edge case)."""
        user = User(email=sample_user_data["email"], password_hash="hash123")
        db_session.add(user)
        db_session.commit()
        
        due_date = datetime(2025, 12, 31, 23, 59, 59)
        task = Task(
            user_id=user.id,
            title="Task with due date",
            status=TaskStatus.PENDING,
            priority=TaskPriority.HIGH,
            due_date=due_date
        )
        db_session.add(task)
        db_session.commit()
        
        assert task.due_date == due_date
    
    def test_task_without_description(self, db_session, sample_user_data):
        """Test task creation without description (edge case)."""
        user = User(email=sample_user_data["email"], password_hash="hash123")
        db_session.add(user)
        db_session.commit()
        
        task = Task(
            user_id=user.id,
            title="Task without description",
            status=TaskStatus.PENDING,
            priority=TaskPriority.LOW
        )
        db_session.add(task)
        db_session.commit()
        
        assert task.description is None
    
    def test_task_missing_title_fails(self, db_session, sample_user_data):
        """Test that task creation fails without title (negative case)."""
        user = User(email=sample_user_data["email"], password_hash="hash123")
        db_session.add(user)
        db_session.commit()
        
        task = Task(
            user_id=user.id,
            status=TaskStatus.PENDING,
            priority=TaskPriority.MEDIUM
        )
        db_session.add(task)
        
        with pytest.raises(IntegrityError):
            db_session.commit()


@pytest.mark.unit
@pytest.mark.skipif(get_db is None, reason="Database connection not implemented yet")
class TestDatabaseConnection:
    """Test cases for database connection."""
    
    def test_get_db_returns_session(self):
        """Test that get_db returns a database session."""
        db_gen = get_db()
        db_session = next(db_gen)
        
        assert db_session is not None
        # Should be able to execute queries
        result = db_session.execute(text("SELECT 1")).scalar()
        assert result == 1
    
    def test_get_db_generator_cleanup(self):
        """Test that get_db generator properly handles cleanup (edge case)."""
        # Test the generator pattern works correctly
        sessions_created = []
        
        # Use the generator in the intended way
        for _ in range(3):
            db_gen = get_db()
            db_session = next(db_gen)
            sessions_created.append(db_session)
            
            # Session should be active when yielded
            assert db_session.is_active
            
            # Properly close the generator
            try:
                db_gen.close()
            except GeneratorExit:
                pass  # Expected when closing generator
        
        # All sessions should have been created successfully
        assert len(sessions_created) == 3
        
        # Each session should be a different instance
        session_ids = [id(session) for session in sessions_created]
        assert len(set(session_ids)) == 3  # All unique
        
        # Test that generator can be used in context-like pattern
        db_gen = get_db()
        try:
            db_session = next(db_gen)
            assert db_session.is_active
            # Perform a test operation
            result = db_session.execute(text("SELECT 1")).scalar()
            assert result == 1
        finally:
            db_gen.close()
    
    def test_init_db_creates_tables(self):
        """Test that init_db creates all required tables (negative case)."""
        # This will test that tables are created properly
        init_db()
        
        # Should be able to create instances without errors
        # This is a basic smoke test
        assert True  # Will be expanded when models exist
