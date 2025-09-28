import React, { useState, useEffect } from 'react';
import {
  Container,
  Box,
  Typography,
  Button,
  TextField,
  InputAdornment,
  Card,
  CardContent,
  Fab,
  Alert,
  Snackbar,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Skeleton,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import {
  Add as AddIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
} from '@mui/icons-material';
import { Header } from '../components/layout/Header';
import { TaskCard } from '../components/tasks/TaskCard';
import { TaskForm } from '../components/tasks/TaskForm';
import { tasksApi } from '../services/api';
import { Task, TaskStatus, TaskPriority, TaskCreateRequest, TaskUpdateRequest } from '../types/api';

export const Dashboard: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [formLoading, setFormLoading] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' });

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<string>('');

  useEffect(() => {
    fetchTasks();
  }, [searchTerm, statusFilter, priorityFilter]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const params: any = {};
      if (searchTerm) params.search = searchTerm;
      if (statusFilter) params.status = statusFilter;
      if (priorityFilter) params.priority = priorityFilter;

      const fetchedTasks = await tasksApi.getTasks(params);
      setTasks(fetchedTasks);
    } catch (error) {
      showSnackbar('Failed to fetch tasks', 'error');
    } finally {
      setLoading(false);
    }
  };

  const showSnackbar = (message: string, severity: 'success' | 'error') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleCreateTask = async (data: TaskCreateRequest) => {
    setFormLoading(true);
    try {
      await tasksApi.createTask(data);
      await fetchTasks();
      showSnackbar('Task created successfully!', 'success');
    } catch (error) {
      showSnackbar('Failed to create task', 'error');
      throw error;
    } finally {
      setFormLoading(false);
    }
  };

  const handleUpdateTask = async (data: TaskUpdateRequest) => {
    if (!editingTask) return;

    setFormLoading(true);
    try {
      await tasksApi.updateTask(editingTask.id, data);
      await fetchTasks();
      showSnackbar('Task updated successfully!', 'success');
    } catch (error) {
      showSnackbar('Failed to update task', 'error');
      throw error;
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    if (!window.confirm('Are you sure you want to delete this task?')) return;

    try {
      await tasksApi.deleteTask(taskId);
      await fetchTasks();
      showSnackbar('Task deleted successfully!', 'success');
    } catch (error) {
      showSnackbar('Failed to delete task', 'error');
    }
  };

  const handleStatusChange = async (taskId: number, status: TaskStatus) => {
    try {
      await tasksApi.updateTaskStatus(taskId, status);
      await fetchTasks();
      showSnackbar(`Task marked as ${status.replace('_', ' ')}!`, 'success');
    } catch (error) {
      showSnackbar('Failed to update task status', 'error');
    }
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setFormOpen(true);
  };

  const handleCloseForm = () => {
    setFormOpen(false);
    setEditingTask(undefined);
  };

  const getTaskStats = () => {
    const pending = tasks.filter(t => t.status === TaskStatus.PENDING).length;
    const inProgress = tasks.filter(t => t.status === TaskStatus.IN_PROGRESS).length;
    const completed = tasks.filter(t => t.status === TaskStatus.COMPLETED).length;
    return { pending, inProgress, completed, total: tasks.length };
  };

  const stats = getTaskStats();

  return (
    <>
      <Header />
      <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
        {/* Demo Banner */}
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Button color="inherit" size="small" href="/docs" target="_blank">
              View API Docs
            </Button>
          }
        >
          🤖 This is an AI-powered demo showcasing complete software development workflow - from business requirements to production deployment in under 2 hours!
        </Alert>

        {/* Stats Cards */}
        <Grid container spacing={3} sx={{ mb: 3 }}>
          <Grid xs={12} sm={3}>
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h4" color="text.secondary">
                  {stats.total}
                </Typography>
                <Typography variant="body2">Total Tasks</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={3}>
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h4" color="warning.main">
                  {stats.pending}
                </Typography>
                <Typography variant="body2">Pending</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={3}>
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h4" color="info.main">
                  {stats.inProgress}
                </Typography>
                <Typography variant="body2">In Progress</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={3}>
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h4" color="success.main">
                  {stats.completed}
                </Typography>
                <Typography variant="body2">Completed</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
        {/* Filters */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Grid container spacing={2} alignItems="center">
              <Grid xs={12} md={4}>
                <TextField
                  fullWidth
                  placeholder="Search tasks..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon />
                      </InputAdornment>
                    ),
                  }}
                />
              </Grid>
              <Grid xs={12} md={3}>
                <FormControl fullWidth>
                  <InputLabel>Status Filter</InputLabel>
                  <Select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    label="Status Filter"
                  >
                    <MenuItem value="">All Statuses</MenuItem>
                    <MenuItem value="pending">Pending</MenuItem>
                    <MenuItem value="in_progress">In Progress</MenuItem>
                    <MenuItem value="completed">Completed</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
              <Grid xs={12} md={3}>
                <FormControl fullWidth>
                  <InputLabel>Priority Filter</InputLabel>
                  <Select
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value)}
                    label="Priority Filter"
                  >
                    <MenuItem value="">All Priorities</MenuItem>
                    <MenuItem value="low">Low</MenuItem>
                    <MenuItem value="medium">Medium</MenuItem>
                    <MenuItem value="high">High</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
              <Grid xs={12} md={2}>
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<FilterIcon />}
                  onClick={() => {
                    setSearchTerm('');
                    setStatusFilter('');
                    setPriorityFilter('');
                  }}
                >
                  Clear
                </Button>
              </Grid>
            </Grid>
          </CardContent>
        </Card>

        {/* Tasks List */}
        <Box>
          <Typography variant="h5" gutterBottom>
            Your Tasks
          </Typography>

          {loading ? (
            <Box>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} variant="rectangular" height={120} sx={{ mb: 2, borderRadius: 1 }} />
              ))}
            </Box>
          ) : tasks.length === 0 ? (
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 6 }}>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No tasks found
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {searchTerm || statusFilter || priorityFilter
                    ? 'Try adjusting your filters or search term'
                    : 'Create your first task to get started!'}
                </Typography>
                <Button variant="contained" onClick={() => setFormOpen(true)} startIcon={<AddIcon />}>
                  Create Task
                </Button>
              </CardContent>
            </Card>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onEdit={handleEditTask}
                onDelete={handleDeleteTask}
                onStatusChange={handleStatusChange}
              />
            ))
          )}
        </Box>

        {/* Floating Action Button */}
        <Fab
          color="primary"
          sx={{ position: 'fixed', bottom: 16, right: 16 }}
          onClick={() => setFormOpen(true)}
        >
          <AddIcon />
        </Fab>

        {/* Task Form */}
        <TaskForm
          open={formOpen}
          onClose={handleCloseForm}
          onSubmit={(data) => editingTask ? handleUpdateTask(data as TaskUpdateRequest) : handleCreateTask(data as TaskCreateRequest)}
          task={editingTask}
          loading={formLoading}
        />

        {/* Snackbar */}
        <Snackbar
          open={snackbar.open}
          autoHideDuration={4000}
          onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        >
          <Alert severity={snackbar.severity} onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}>
            {snackbar.message}
          </Alert>
        </Snackbar>
      </Container>
    </>
  );
};