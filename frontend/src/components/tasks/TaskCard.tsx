import React from 'react';
import {
  Card,
  CardContent,
  Typography,
  Chip,
  Box,
  IconButton,
  Menu,
  MenuItem,
  Divider,
} from '@mui/material';
import {
  MoreVert as MoreVertIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckCircleIcon,
  PlayArrow as PlayArrowIcon,
  Pause as PauseIcon,
} from '@mui/icons-material';
import { Task, TaskStatus, TaskPriority } from '../../types/api';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (taskId: number) => void;
  onStatusChange: (taskId: number, status: TaskStatus) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onEdit,
  onDelete,
  onStatusChange,
}) => {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const getStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.PENDING:
        return 'default';
      case TaskStatus.IN_PROGRESS:
        return 'info';
      case TaskStatus.COMPLETED:
        return 'success';
      default:
        return 'default';
    }
  };

  const getPriorityColor = (priority: TaskPriority) => {
    switch (priority) {
      case TaskPriority.LOW:
        return 'success';
      case TaskPriority.MEDIUM:
        return 'warning';
      case TaskPriority.HIGH:
        return 'error';
      default:
        return 'default';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getNextStatus = (currentStatus: TaskStatus): TaskStatus | null => {
    switch (currentStatus) {
      case TaskStatus.PENDING:
        return TaskStatus.IN_PROGRESS;
      case TaskStatus.IN_PROGRESS:
        return TaskStatus.COMPLETED;
      default:
        return null;
    }
  };

  const getStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.PENDING:
        return <PlayArrowIcon fontSize="small" />;
      case TaskStatus.IN_PROGRESS:
        return <CheckCircleIcon fontSize="small" />;
      case TaskStatus.COMPLETED:
        return <PauseIcon fontSize="small" />;
      default:
        return null;
    }
  };

  const nextStatus = getNextStatus(task.status);

  return (
    <Card
      sx={{
        mb: 2,
        transition: 'all 0.2s',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: 3,
        },
        opacity: task.status === TaskStatus.COMPLETED ? 0.8 : 1,
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1 }}>
            <Typography
              variant="h6"
              component="h3"
              sx={{
                mb: 1,
                textDecoration: task.status === TaskStatus.COMPLETED ? 'line-through' : 'none',
              }}
            >
              {task.title}
            </Typography>

            {task.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {task.description}
              </Typography>
            )}

            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
              <Chip
                label={task.status.replace('_', ' ').toUpperCase()}
                color={getStatusColor(task.status)}
                size="small"
              />
              <Chip
                label={`${task.priority.toUpperCase()} PRIORITY`}
                color={getPriorityColor(task.priority)}
                size="small"
                variant="outlined"
              />
            </Box>

            {task.due_date && (
              <Typography variant="caption" color="text.secondary">
                Due: {formatDate(task.due_date)}
              </Typography>
            )}
          </Box>

          <Box>
            <IconButton onClick={handleMenuOpen} size="small">
              <MoreVertIcon />
            </IconButton>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={handleMenuClose}
            >
              {nextStatus && (
                <MenuItem
                  onClick={() => {
                    onStatusChange(task.id, nextStatus);
                    handleMenuClose();
                  }}
                >
                  {getStatusIcon(task.status)}
                  <Typography sx={{ ml: 1 }}>
                    Mark as {nextStatus.replace('_', ' ')}
                  </Typography>
                </MenuItem>
              )}
              {nextStatus && <Divider />}
              <MenuItem
                onClick={() => {
                  onEdit(task);
                  handleMenuClose();
                }}
              >
                <EditIcon fontSize="small" />
                <Typography sx={{ ml: 1 }}>Edit</Typography>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  onDelete(task.id);
                  handleMenuClose();
                }}
                sx={{ color: 'error.main' }}
              >
                <DeleteIcon fontSize="small" />
                <Typography sx={{ ml: 1 }}>Delete</Typography>
              </MenuItem>
            </Menu>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
};