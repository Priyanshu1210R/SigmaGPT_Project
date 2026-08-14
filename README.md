# SigmaGPT

A full-stack ChatGPT-style AI chat application built with the MERN stack. Users can sign up, chat with a Gemini-powered assistant (including image inputs), manage multiple conversation threads, and switch between light and dark themes. A simple free-tier/premium usage model is built in.

## Features

- **Authentication** — email/password signup and login secured with JWT and bcrypt-hashed passwords
- **AI chat** — messages are answered by Google's Gemini API (`gemini-2.5-flash`)
- **Image input** — attach an image to a message for the assistant to analyze
- **Threaded conversations** — create, view, and delete multiple chat threads, each with its own history stored in MongoDB
- **Usage limits** — 20 free messages per account, with an in-app upgrade flow to a "Premium" plan
- **Light/dark theme** toggle
- **Account settings** — update username, email, and password from the app

## Tech Stack

**Frontend**
- React 19 + Vite
- react-markdown / rehype-highlight for rendering assistant responses
- react-spinners for loading states

**Backend**
- Node.js + Express
- MongoDB with Mongoose
- JSON Web Tokens (jsonwebtoken) for auth, bcryptjs for password hashing
- Google Gemini API for chat completions

## Project Structure

```
SigmaGPT_Project/
├── Backend/
│   ├── server.js              # Express app entry point
│   ├── models/
│   │   ├── User.js            # User schema (auth, usage count, premium flag)
│   │   └── Thread.js          # Chat thread + message schema
│   ├── routes/
│   │   ├── auth.js            # Signup, login, profile, upgrade, user count
│   │   └── chat.js            # Thread CRUD + chat endpoint
│   ├── middlewares/
│   │   └── authMiddleware.js  # JWT verification
│   └── utils/
│       └── gemini.js          # Gemini API call wrapper
└── Frontend/
    └── src/
        ├── App.jsx             # Root component / auth gate
        ├── AuthPage.jsx        # Login / signup UI
        ├── AuthContext.jsx     # Auth state, token storage, API calls
        ├── ThemeContext.jsx    # Light/dark theme provider
        ├── MyContext.jsx       # Shared chat state (prompt, threads, etc.)
        ├── Sidebar.jsx         # Thread list and navigation
        ├── ChatWindow.jsx      # Chat UI, message sending, settings/upgrade modals
        └── Chat.jsx            # Message rendering
```

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- A MongoDB instance (local or Atlas)
- A Google Gemini API key

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/SigmaGPT_Project.git
cd SigmaGPT_Project
```

### 2. Backend setup

```bash
cd Backend
npm install
```

Create a `.env` file inside `Backend/`:

```env
PORT=8080
MONGODB_URL=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_gemini_api_key
```

Run the backend:

```bash
npm run dev     # with nodemon (auto-restart)
# or
npm start
```

The server runs at `http://localhost:8080` by default.

### 3. Frontend setup

```bash
cd Frontend
npm install
npm run dev
```

The app runs at `http://localhost:5173` by default (Vite's default port).

> **Note:** The frontend currently points its API requests at a deployed backend URL (`https://sigmagpt-project-backend.onrender.com`) inside `Sidebar.jsx` and `ChatWindow.jsx`. For local development, update the `BACKEND` constant in those files to `http://localhost:8080`, or refactor it into a `VITE_` environment variable.

## API Overview

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| POST | `/api/auth/signup` | Register a new user | No |
| POST | `/api/auth/login` | Log in and receive a JWT | No |
| GET | `/api/auth/me` | Get the current user's profile | Yes |
| PUT | `/api/auth/update-profile` | Update username/email/password | Yes |
| POST | `/api/auth/upgrade` | Upgrade account to Premium | Yes |
| GET | `/api/auth/users-count` | Get total registered user count | Yes |
| GET | `/api/thread` | List all threads for the user | Yes |
| GET | `/api/thread/:threadId` | Get a single thread | Yes |
| DELETE | `/api/thread/:threadId` | Delete a thread | Yes |
| POST | `/api/chat` | Send a message (and optional image) to the assistant | Yes |

Authenticated requests must include an `Authorization: Bearer <token>` header.

## Usage Limits

Free accounts are capped at **20 messages**. Once the limit is reached, the chat endpoint returns a `403` with a `FREE_LIMIT_REACHED` error, and the frontend prompts the user to upgrade to Premium. (Note: the upgrade flow in `auth.js` simply flips the `isPremium` flag — no real payment processing is wired in yet.)

## Screenshots

| | |
|---|---|
| ![Chat response with sliding window explanation](Images/Screenshot%202026-08-14%20190948.png) | ![Account menu with settings, upgrade plan, and users](Images/Screenshot%202026-08-14%20190739.png) |
| ![Thread list with delete option, light mode](Images/Screenshot%202026-08-14%20190722.png) | ![Start a new chat, dark mode](Images/Screenshot%202026-08-14%20190701.png) |

> Screenshots are stored in the `Images/` folder at the root of this repository.

## License

No license specified yet — add one (e.g., MIT) if you plan to share or open-source this project.

## Live Demo

🔗 [https://sigmagpt-project-frontend.onrender.com](https://sigmagpt-project-frontend.onrender.com)
