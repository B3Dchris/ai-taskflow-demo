"""Debug script to test specific functionality."""

import sys
sys.path.append('.')

from SRC.database.models import User, Task, TaskStatus, TaskPriority
from SRC.database.connection import get_db, init_db
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Test database connection
print("Testing database connection...")
try:
    db_gen = get_db()
    db_session = next(db_gen)
    print(f"✅ Database session created: {db_session}")
    
    # Test query
    result = db_session.execute("SELECT 1").scalar()
    print(f"✅ Query executed successfully: {result}")
    
    # Test session status
    print(f"Session active: {db_session.is_active}")
    
    # Close generator
    try:
        next(db_gen)
    except StopIteration:
        print("✅ Generator properly closed")
    
    print(f"Session active after close: {db_session.is_active}")
    
except Exception as e:
    print(f"❌ Error: {e}")

# Test model creation
print("\nTesting model creation...")
try:
    # Create in-memory database for testing
    engine = create_engine("sqlite:///:memory:")
    from SRC.database.models import Base
    Base.metadata.create_all(bind=engine)
    
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    
    # Create user
    user = User(email="test@example.com", password_hash="hash123")
    session.add(user)
    session.commit()
    print(f"✅ User created: {user.id}, {user.email}")
    
    # Create task
    task = Task(
        user_id=user.id,
        title="Test Task",
        status=TaskStatus.PENDING,
        priority=TaskPriority.MEDIUM
    )
    session.add(task)
    session.commit()
    print(f"✅ Task created: {task.id}, {task.title}")
    
    # Test task without title (should fail)
    try:
        bad_task = Task(user_id=user.id, status=TaskStatus.PENDING)
        session.add(bad_task)
        session.commit()
        print("❌ Task without title should have failed!")
    except Exception as e:
        print(f"✅ Task without title properly failed: {e}")
        session.rollback()
    
    session.close()
    
except Exception as e:
    print(f"❌ Model creation error: {e}")
    import traceback
    traceback.print_exc()

print("\nDebug complete!")
