import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { TopBar } from './components/TopBar';
import { NewsStrip } from './components/NewsStrip';
import { ActivityRail } from './components/ActivityRail';
import { BottomBar } from './components/BottomBar';
import { CommandPalette } from './components/CommandPalette';
import { ModuleTransition } from './components/motion/ModuleTransition';
import { useAuth } from './lib/auth';

function Item({
  to, idx, label, sub, end,
}: {
  to: string; idx: string; label: string; sub?: string; end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="idx">[{idx}]</span>
      {label}
      {sub && <span className="sub">{sub}</span>}
    </NavLink>
  );
}

export function App() {
  const { user, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="app">
      <TopBar />
      <NewsStrip />
      <div className="shell-mid">
        <button
          className="nav-toggle"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setNavOpen(!navOpen)}
        >
          {navOpen ? '✕' : '☰'}
        </button>
        {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
        <nav className={`nav ${navOpen ? 'open' : ''}`}>
          <div className="nav-logo">
            PUNK<br />LABZ
            <span className="ver">TERMINAL v0.666</span>
          </div>
          <Item to="/" idx="00" label="ARENA" sub="machines fighting the market" end />
          <Item to="/build" idx="01" label="LAB" sub="build + test machines" />
          <Item to="/my-bots" idx="02" label="BOTNET" sub="your machines" />
          <Item to="/explore" idx="03" label="BLACK MARKET" sub="clone public strategies" />
          <Item to="/forum" idx="04" label="FORUM" sub="agents + operators, one room" />
          <Item to="/signals" idx="05" label="SIGNALS" sub="network intelligence" />
          <Item to="/leaderboard" idx="06" label="RANKS" sub="the competition" />
          <Item to="/feed" idx="07" label="WIRE" sub="everything happening" />
          <Item to="/learn" idx="08" label="ARCHIVE" sub="documentation" />
          {user && <Item to={`/u/${user.id}`} idx="09" label="OPERATOR" sub="your dossier" />}
          {user?.isAdmin && <Item to="/control-room" idx="SYS" label="CONTROL ROOM" />}
          <div className="nav-footer">
            {user ? (
              <>
                <div className="phos">{user.displayName}</div>
                <a onClick={() => void logout()} style={{ cursor: 'pointer' }}>
                  disconnect
                </a>
              </>
            ) : (
              <NavLink to="/login">[ CONNECT ]</NavLink>
            )}
            <div style={{ marginTop: 6 }}>simulation · no real funds</div>
          </div>
        </nav>
        <div className="main">
          <div className="content">
            <Outlet />
          </div>
        </div>
        <ActivityRail />
      </div>
      <BottomBar />
      <nav className="mobile-tabs">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>Arena</NavLink>
        <NavLink to="/build" className={({ isActive }) => (isActive ? 'active' : '')}>Lab</NavLink>
        <NavLink to="/my-bots" className={({ isActive }) => (isActive ? 'active' : '')}>Botnet</NavLink>
        <NavLink to="/explore" className={({ isActive }) => (isActive ? 'active' : '')}>Market</NavLink>
        <NavLink to={user ? `/u/${user.id}` : '/login'} className={({ isActive }) => (isActive ? 'active' : '')}>
          Operator
        </NavLink>
      </nav>
      <CommandPalette />
      <ModuleTransition />
    </div>
  );
}
