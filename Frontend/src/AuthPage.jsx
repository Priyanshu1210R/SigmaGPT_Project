import { useState } from "react";
import { useAuth } from "./AuthContext.jsx";
import logo from "./assets/blacklogo.png";
import "./Auth.css";

function AuthPage() {
  const { login, signup } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isLogin) {
        await login(form.email, form.password);
      } else {
        if (!form.username.trim()) {
          setError("Username is required");
          setLoading(false);
          return;
        }
        await signup(form.username, form.email, form.password);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsLogin(!isLogin);
    setForm({ username: "", email: "", password: "" });
    setError("");
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <img src={logo} alt="SigmaGPT" />
          <h1>SigmaGPT</h1>
        </div>

        <h2>{isLogin ? "Welcome back" : "Create an account"}</h2>
        <p className="auth-subtitle">
          {isLogin ? "Sign in to continue your conversations" : "Start chatting with SigmaGPT"}
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          {!isLogin && (
            <div className="auth-field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                type="text"
                placeholder="Enter your username"
                value={form.username}
                onChange={handleChange}
                autoComplete="username"
              />
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="Enter your email"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder={isLogin ? "Enter your password" : "At least 6 characters"}
              value={form.password}
              onChange={handleChange}
              autoComplete={isLogin ? "current-password" : "new-password"}
            />
          </div>

          {error && <p className="auth-error"><i className="fa-solid fa-circle-exclamation"></i> {error}</p>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? (
              <span className="auth-loading">
                <i className="fa-solid fa-circle-notch fa-spin"></i>
                {isLogin ? " Signing in..." : " Creating account..."}
              </span>
            ) : (
              isLogin ? "Sign In" : "Sign Up"
            )}
          </button>
        </form>

        <p className="auth-toggle">
          {isLogin ? "Don't have an account?" : "Already have an account?"}
          <button onClick={toggleMode} className="auth-toggle-btn">
            {isLogin ? " Sign up" : " Sign in"}
          </button>
        </p>
      </div>

      <p className="auth-footer">By Priyanshu Ranjan</p>
    </div>
  );
}

export default AuthPage;
