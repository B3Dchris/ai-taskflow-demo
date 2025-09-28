import axios, { AxiosResponse } from 'axios';
import {
  User,
  Task,
  LoginRequest,
  RegisterRequest,
  AuthResponse,
  TaskCreateRequest,
  TaskUpdateRequest,
  TaskStatus
} from '../types/api';

// API Configuration
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authApi = {
  register: async (data: RegisterRequest): Promise<AuthResponse> => {
    const response: AxiosResponse<AuthResponse> = await api.post('/auth/register', data);
    return response.data;
  },

  login: async (data: LoginRequest): Promise<AuthResponse> => {
    const response: AxiosResponse<AuthResponse> = await api.post('/auth/login', data);
    return response.data;
  },
};

// Tasks API
export const tasksApi = {
  getTasks: async (params?: {
    status?: string;
    priority?: string;
    search?: string;
  }): Promise<Task[]> => {
    const response: AxiosResponse<Task[]> = await api.get('/tasks', { params });
    return response.data;
  },

  getTask: async (taskId: number): Promise<Task> => {
    const response: AxiosResponse<Task> = await api.get(`/tasks/${taskId}`);
    return response.data;
  },

  createTask: async (data: TaskCreateRequest): Promise<Task> => {
    const response: AxiosResponse<Task> = await api.post('/tasks', data);
    return response.data;
  },

  updateTask: async (taskId: number, data: TaskUpdateRequest): Promise<Task> => {
    const response: AxiosResponse<Task> = await api.put(`/tasks/${taskId}`, data);
    return response.data;
  },

  updateTaskStatus: async (taskId: number, status: TaskStatus): Promise<Task> => {
    const response: AxiosResponse<Task> = await api.patch(`/tasks/${taskId}/status`, status);
    return response.data;
  },

  deleteTask: async (taskId: number): Promise<void> => {
    await api.delete(`/tasks/${taskId}`);
  },
};

// Health check
export const healthApi = {
  check: async (): Promise<{ status: string; version: string }> => {
    const response = await api.get('/health');
    return response.data;
  },
};

export default api;