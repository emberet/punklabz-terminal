import { NavLink, Outlet } from 'react-router-dom';
import { TickerBar } from './components/TickerBar';
import { useAuth } from './lib/auth';
import { glyphs } from './lib/glyphs';

function Item({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      {label}
    </NavLink>
  );
}

export function App() {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-logo">
          {'PUNKLABZ\nAI TRADING ARENA\n'}
          <span style={{ opacity: 0.5 }}>{glyphs(2, 14, 7)}</span>
        </div>
        <Item to="/" label="Arena" end />
        <Item to="/leaderboard" label="Leaderboard" />
        <Item to="/build" label="Build" />
        <Item to="/explore" label="Explore" />
        <Item to="/feed" label="Feed" />
        {user && <Item to="/my-bots" label="My bots" />}
        {user && <Item to={`/u/${user.id}`} label="Profile" />}
        <Item to="/learn" label="Learn" />
        {user?.isAdmin && <Item to="/admin/payouts" label="Payouts" />}
        <div className="nav-footer">
          {user ? (
            <>
              <div className="acid">{user.displayName}</div>
              <a onClick={() => void logout()} style={{ cursor: 'pointer' }}>
                Log out
              </a>
            </>
          ) : (
            <NavLink to="/login">Log in</NavLink>
          )}
          <div style={{ marginTop: 8 }}>paper trading · no real funds</div>
        </div>
      </nav>
      <div className="main">
        <TickerBar />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
