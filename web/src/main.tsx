import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles/theme.css';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { TradingFloor } from './pages/TradingFloor';
import { BotDetail } from './pages/BotDetail';
import { Leaderboard } from './pages/Leaderboard';
import { Toolkit } from './pages/Toolkit';
import { Manager } from './pages/Manager';
import { Docs } from './pages/Docs';
import { Login } from './pages/Login';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <TradingFloor /> },
      { path: 'bots/:id', element: <BotDetail /> },
      { path: 'leaderboard', element: <Leaderboard /> },
      { path: 'toolkit', element: <Toolkit /> },
      { path: 'manager', element: <Manager /> },
      { path: 'docs', element: <Docs /> },
      { path: 'login', element: <Login /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>,
);
