"""Task service for CRUD operations."""

from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_

from ..database.models import Task, User, TaskStatus, TaskPriority
from ..shared.exceptions import (
    TaskNotFoundError, 
    UnauthorizedError, 
    ValidationError,
    UserNotFoundError
)


def create_task(user_id: int, task_data: Dict[str, Any], db: Session) -> Task:
    """Create new task for user.
    
    Preconditions: user_id exists, task_data validated
    Postconditions: task created and saved to database
    Raises: ValidationError, UserNotFoundError
    """
    # Validate user exists
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise UserNotFoundError(f"User with ID {user_id} not found")
    
    # Validate required fields
    title = task_data.get("title", "").strip()
    if not title:
        raise ValidationError("Task title is required")
    
    if len(title) > 200:
        raise ValidationError("Task title cannot exceed 200 characters")
    
    description = task_data.get("description")
    if description and len(description) > 1000:
        raise ValidationError("Task description cannot exceed 1000 characters")
    
    # Parse status and priority
    status_str = task_data.get("status", "pending")
    priority_str = task_data.get("priority", "medium")
    
    # Convert string values to enums
    try:
        if isinstance(status_str, str):
            status = TaskStatus(status_str.lower())
        else:
            status = status_str or TaskStatus.PENDING
    except ValueError:
        status = TaskStatus.PENDING
    
    try:
        if isinstance(priority_str, str):
            priority = TaskPriority(priority_str.lower())
        else:
            priority = priority_str or TaskPriority.MEDIUM
    except ValueError:
        priority = TaskPriority.MEDIUM
    
    # Create task
    task = Task(
        user_id=user_id,
        title=title,
        description=description,
        status=status,
        priority=priority,
        due_date=task_data.get("due_date")
    )
    
    db.add(task)
    db.commit()
    db.refresh(task)
    
    return task


def get_user_tasks(
    user_id: int, 
    db: Session, 
    status: Optional[str] = None,
    priority: Optional[str] = None
) -> List[Task]:
    """Get all tasks for user with optional filtering.
    
    Preconditions: user_id exists
    Postconditions: list of user's tasks, empty list if none
    """
    query = db.query(Task).filter(Task.user_id == user_id)
    
    # Apply status filter
    if status:
        try:
            status_enum = TaskStatus(status.lower())
            query = query.filter(Task.status == status_enum)
        except ValueError:
            # Invalid status, return empty list
            return []
    
    # Apply priority filter
    if priority:
        try:
            priority_enum = TaskPriority(priority.lower())
            query = query.filter(Task.priority == priority_enum)
        except ValueError:
            # Invalid priority, return empty list
            return []
    
    # Order by creation date (newest first)
    query = query.order_by(Task.created_at.desc())
    
    return query.all()


def get_task_by_id(task_id: int, user_id: int, db: Session) -> Task:
    """Get specific task by ID for user.
    
    Preconditions: task_id and user_id exist
    Postconditions: task object if user owns it
    Raises: TaskNotFoundError, UnauthorizedError
    """
    task = db.query(Task).filter(Task.id == task_id).first()
    
    if not task:
        raise TaskNotFoundError(f"Task with ID {task_id} not found")
    
    if task.user_id != user_id:
        raise UnauthorizedError("You are not authorized to access this task")
    
    return task


def update_task(task_id: int, user_id: int, updates: Dict[str, Any], db: Session) -> Task:
    """Update task with new data.
    
    Preconditions: task exists, user owns task, updates validated
    Postconditions: task updated in database
    Raises: TaskNotFoundError, UnauthorizedError, ValidationError
    """
    # Get existing task with authorization check
    task = get_task_by_id(task_id, user_id, db)
    
    # Validate and apply updates
    for field, value in updates.items():
        if field == "title":
            if not value or not value.strip():
                raise ValidationError("Task title cannot be empty")
            if len(value.strip()) > 200:
                raise ValidationError("Task title cannot exceed 200 characters")
            task.title = value.strip()
        
        elif field == "description":
            if value and len(value) > 1000:
                raise ValidationError("Task description cannot exceed 1000 characters")
            task.description = value
        
        elif field == "status":
            try:
                if isinstance(value, str):
                    task.status = TaskStatus(value.lower())
                else:
                    task.status = value
            except ValueError:
                raise ValidationError(f"Invalid status: {value}")
        
        elif field == "priority":
            try:
                if isinstance(value, str):
                    task.priority = TaskPriority(value.lower())
                else:
                    task.priority = value
            except ValueError:
                raise ValidationError(f"Invalid priority: {value}")
        
        elif field == "due_date":
            task.due_date = value
    
    db.commit()
    db.refresh(task)
    
    return task


def delete_task(task_id: int, user_id: int, db: Session) -> bool:
    """Delete task by ID.
    
    Preconditions: task exists, user owns task
    Postconditions: task removed from database
    Raises: TaskNotFoundError, UnauthorizedError
    """
    # Get existing task with authorization check
    task = get_task_by_id(task_id, user_id, db)
    
    db.delete(task)
    db.commit()
    
    return True


def search_tasks(user_id: int, query: str, db: Session) -> List[Task]:
    """Search tasks by title or description.
    
    Preconditions: user_id exists, query is string
    Postconditions: list of matching tasks
    """
    if not query or not query.strip():
        return []
    
    search_term = f"%{query.strip().lower()}%"
    
    tasks = db.query(Task).filter(
        and_(
            Task.user_id == user_id,
            or_(
                Task.title.ilike(search_term),
                Task.description.ilike(search_term)
            )
        )
    ).order_by(Task.created_at.desc()).all()
    
    return tasks
