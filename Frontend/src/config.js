// Set VITE_API_URL in Frontend/.env (e.g. http://localhost:8080) for local dev.
export const BACKEND = (import.meta.env.VITE_API_URL || "https://sigmagpt-project-backend.onrender.com").replace(/\/$/, "");
