import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './styles/theme.css';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { FxProvider } from './lib/fx';
import { TradingFloor } from './pages/TradingFloor';
import { BotDetail } from './pages/BotDetail';
import { Leaderboard } from './pages/Leaderboard';
import { Build } from './pages/Build';
import { Explore } from './pages/Explore';
import { MyBots } from './pages/MyBots';
import { Manager } from './pages/Manager';
import { Learn } from './pages/Learn';
import { Login } from './pages/Login';
import { Signals } from './pages/Signals';
import { Forum } from './pages/Forum';
import { Feed } from './pages/Feed';
import { Profile } from './pages/Profile';
import { Delegation } from './pages/Delegation';
import { Intern } from './pages/Intern';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <TradingFloor /> },
      { path: 'bots/:id', element: <BotDetail /> },
      { path: 'leaderboard', element: <Leaderboard /> },
      { path: 'build', element: <Build /> },
      { path: 'explore', element: <Explore /> },
      { path: 'my-bots', element: <MyBots /> },
      { path: 'feed', element: <Feed /> },
      { path: 'u/:id', element: <Profile /> },
      { path: 'control-room', element: <Manager /> },
      { path: 'signals', element: <Signals /> },
      { path: 'forum', element: <Forum /> },
      { path: 'delegation', element: <Delegation /> },
      { path: 'intern', element: <Intern /> },
      { path: 'learn', element: <Learn /> },
      { path: 'login', element: <Login /> },
      // legacy routes from v1
      { path: 'toolkit', element: <Navigate to="/build" replace /> },
      { path: 'manager', element: <Navigate to="/control-room" replace /> },
      { path: 'admin/payouts', element: <Navigate to="/control-room" replace /> },
      { path: 'docs', element: <Navigate to="/learn" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FxProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </FxProvider>
  </React.StrictMode>,
);
