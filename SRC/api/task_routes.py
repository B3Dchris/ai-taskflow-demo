"""Task management routes for TaskFlow API."""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime

from ..database.connection import get_db
from ..database.models import User, TaskStatus, TaskPriority
from ..tasks.service import (
    create_task, get_user_tasks, get_task_by_id, 
    update_task, delete_task, search_tasks
)
from ..tasks.schemas import TaskCreate, TaskUpdate, TaskResponse
from ..shared.exceptions import (
    TaskNotFoundError, UnauthorizedError, ValidationError, UserNotFoundError
)

router = APIRouter()


# Import get_current_user function - will be defined in main.py
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from ..auth.service import validate_token

security = HTTPBearer()

async def get_current_user_local(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    """Get current authenticated user from JWT token."""
    try:
        token = credentials.credentials
        user = validate_token(token, db)
        return user
    except Exception as e:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


@router.post("/", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_new_task(
    task_data: TaskCreate,
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Create a new task for the authenticated user.
    
    Creates a task with the provided data and assigns it to the current user.
    All fields except title are optional and will use sensible defaults.
    """
    try:
        task_dict = task_data.dict()
        task = create_task(current_user.id, task_dict, db)
        return TaskResponse.from_orm(task)
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e)
        )
    except UserNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.get("/", response_model=List[TaskResponse])
async def list_tasks(
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by task status"),
    priority_filter: Optional[str] = Query(None, alias="priority", description="Filter by task priority"),
    search: Optional[str] = Query(None, description="Search in task title and description"),
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Get all tasks for the authenticated user.
    
    Supports filtering by status, priority, and text search.
    Returns tasks ordered by creation date (newest first).
    """
    try:
        if search:
            # Use search functionality
            tasks = search_tasks(current_user.id, search, db)
        else:
            # Use filtering functionality
            tasks = get_user_tasks(current_user.id, db, status_filter, priority_filter)
        
        return [TaskResponse.from_orm(task) for task in tasks]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving tasks"
        )


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Get a specific task by ID.
    
    Returns the task if it belongs to the authenticated user.
    Returns 404 if task doesn't exist or 403 if user doesn't own it.
    """
    try:
        task = get_task_by_id(task_id, current_user.id, db)
        return TaskResponse.from_orm(task)
    except TaskNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except UnauthorizedError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e)
        )


@router.put("/{task_id}", response_model=TaskResponse)
async def update_existing_task(
    task_id: int,
    task_updates: TaskUpdate,
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Update an existing task.
    
    Updates only the provided fields, leaving others unchanged.
    User can only update their own tasks.
    """
    try:
        # Only include non-None values in updates
        updates = {k: v for k, v in task_updates.dict().items() if v is not None}
        task = update_task(task_id, current_user.id, updates, db)
        return TaskResponse.from_orm(task)
    except TaskNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except UnauthorizedError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e)
        )
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e)
        )


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_existing_task(
    task_id: int,
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Delete a task by ID.
    
    Permanently removes the task from the database.
    User can only delete their own tasks.
    """
    try:
        delete_task(task_id, current_user.id, db)
        return  # 204 No Content response
    except TaskNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except UnauthorizedError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e)
        )


@router.patch("/{task_id}/status", response_model=TaskResponse)
async def update_task_status(
    task_id: int,
    status: TaskStatus,
    current_user: User = Depends(get_current_user_local),
    db: Session = Depends(get_db)
):
    """Update only the status of a task.
    
    Convenience endpoint for quickly changing task status
    (e.g., marking as completed, in progress, etc.).
    """
    try:
        updates = {"status": status}
        task = update_task(task_id, current_user.id, updates, db)
        return TaskResponse.from_orm(task)
    except TaskNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except UnauthorizedError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e)
        )
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e)
        )
