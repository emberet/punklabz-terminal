import { NavLink, Outlet } from 'react-router-dom';
import { TickerBar } from './components/TickerBar';
import { useAuth } from './lib/auth';

const LOGO = `█▀█ █ █ █▄ █ █▄▀
█▀▀ █▄█ █ ▀█ █ █
L A B Z // T E R M`;

export function App() {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-logo">{LOGO}</div>
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Trading Floor
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Leaderboard
        </NavLink>
        <NavLink to="/toolkit" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Toolkit
        </NavLink>
        <NavLink to="/manager" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Manager
        </NavLink>
        <NavLink to="/docs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Docs
        </NavLink>
        <div className="nav-footer">
          {user ? (
            <>
              <div className="green">{user.displayName}</div>
              <a onClick={() => void logout()} style={{ cursor: 'pointer' }}>
                [ logout ]
              </a>
            </>
          ) : (
            <NavLink to="/login">[ log in ]</NavLink>
          )}
          <div style={{ marginTop: 8 }}>paper trading only</div>
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
