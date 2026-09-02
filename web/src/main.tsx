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
import { Intern } from './pages/Intern';
import { Billing } from './pages/Billing';
import { PrivyProvider } from '@privy-io/react-auth';
import { defineChain } from 'viem';

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
      { path: 'delegation', element: <Navigate to="/" replace /> },
      { path: 'intern', element: <Intern /> },
      { path: 'billing', element: <Billing /> },
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

const app = (
  <FxProvider>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </FxProvider>
);

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com' } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {import.meta.env.VITE_PRIVY_APP_ID ? (
      <PrivyProvider
        appId={import.meta.env.VITE_PRIVY_APP_ID}
        config={{
          loginMethods: ['email', 'wallet'],
          supportedChains: [robinhoodChain],
          defaultChain: robinhoodChain,
          embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
        }}
      >
        {app}
      </PrivyProvider>
    ) : app}
  </React.StrictMode>,
);
