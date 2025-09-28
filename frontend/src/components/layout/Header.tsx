import React from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  IconButton,
  Chip,
} from '@mui/material';
import {
  Logout as LogoutIcon,
  SmartToy as SmartToyIcon,
} from '@mui/icons-material';
import { useAuth } from '../../contexts/AuthContext';

export const Header: React.FC = () => {
  const { logout } = useAuth();

  return (
    <AppBar position="static" elevation={2}>
      <Toolbar>
        <Box sx={{ display: 'flex', alignItems: 'center', flex: 1 }}>
          <SmartToyIcon sx={{ mr: 2 }} />
          <Typography variant="h6" component="div">
            TaskFlow AI Demo
          </Typography>
          <Chip
            label="AI-Powered"
            size="small"
            sx={{
              ml: 2,
              bgcolor: 'rgba(255, 255, 255, 0.2)',
              color: 'white',
            }}
          />
        </Box>

        <Button
          color="inherit"
          onClick={logout}
          startIcon={<LogoutIcon />}
          sx={{ textTransform: 'none' }}
        >
          Sign Out
        </Button>
      </Toolbar>
    </AppBar>
  );
};