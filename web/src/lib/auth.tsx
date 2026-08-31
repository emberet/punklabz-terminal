import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface Me {
  id: number;
  email: string | null;
  walletAddress: string | null;
  displayName: string;
  isAdmin: boolean;
  hasEmail?: boolean;
  hasWallet?: boolean;
}

interface AuthState {
  user: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const res = await api.get<{ user: Me | null }>('/api/me');
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
