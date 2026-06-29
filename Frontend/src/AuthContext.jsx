import { createContext, useContext, useState, useEffect } from "react";

const AuthContext = createContext();

const BACKEND = "https://sigmagpt-project-backend.onrender.com";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem("sigma_token"));
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) { setAuthLoading(false); return; }
      try {
        const res = await fetch(`${BACKEND}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else {
          logout();
        }
      } catch {
        logout();
      } finally {
        setAuthLoading(false);
      }
    };
    verifyToken();
  }, []);

  const login = async (email, password) => {
    const res = await fetch(`${BACKEND}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    localStorage.setItem("sigma_token", data.token);
    setToken(data.token);
    setUser(data.user);
    return data;
  };

  const signup = async (username, email, password) => {
    const res = await fetch(`${BACKEND}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Signup failed");
    localStorage.setItem("sigma_token", data.token);
    setToken(data.token);
    setUser(data.user);
    return data;
  };

  const logout = () => {
    localStorage.removeItem("sigma_token");
    setToken(null);
    setUser(null);
  };

  // ---- Settings: update profile ----
  const updateProfile = async ({ username, email, currentPassword, newPassword }) => {
    const res = await fetch(`${BACKEND}/api/auth/update-profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ username, email, currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Update failed");
    // Refresh token and user if email changed
    if (data.token) {
      localStorage.setItem("sigma_token", data.token);
      setToken(data.token);
    }
    setUser(data.user);
    return data;
  };

  // ---- Upgrade to premium ----
  const upgradeToPremium = async () => {
    const res = await fetch(`${BACKEND}/api/auth/upgrade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upgrade failed");
    setUser(prev => ({ ...prev, isPremium: true }));
    return data;
  };

  return (
    <AuthContext.Provider value={{ user, setUser, token, authLoading, login, signup, logout, updateProfile, upgradeToPremium }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
