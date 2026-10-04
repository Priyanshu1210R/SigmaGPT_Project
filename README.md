# SigmaGPT

[![CI](https://github.com/Priyanshu1210R/SigmaGPT_Project/actions/workflows/ci.yml/badge.svg)](https://github.com/Priyanshu1210R/SigmaGPT_Project/actions/workflows/ci.yml)

A full-stack, ChatGPT-style AI assistant built with the MERN stack and Google Gemini. Users can sign up, chat with streaming responses, attach images, upload documents (PDF / TXT / Markdown) and ask questions about them with cited answers (RAG), and manage multiple conversation threads. A free-tier / premium usage model is built in.

🔗 **Live demo:** [sigmagpt-project-frontend.onrender.com](https://sigmagpt-project-frontend.onrender.com)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running with Docker](#running-with-docker)
- [API Overview](#api-overview)
- [Document Q&A (RAG)](#document-qa-rag)
- [RAG Evaluation](#rag-evaluation)
- [Usage Limits & Rate Limits](#usage-limits--rate-limits)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Screenshots](#screenshots)
- [License](#license)

---

## Features

- **Authentication**: email/password signup and login secured with JWT and bcrypt-hashed passwords
- **Streaming AI chat**: responses from Google Gemini (`gemini-2.5-flash` by default) streamed to the UI over Server-Sent Events
- **Image input**: attach an image to a message for the assistant to analyze
- **Document Q&A (RAG)**: upload PDF, TXT or Markdown files to a thread and ask questions; answers cite their sources with inline `[1] [2]` markers and a "Sources" list
- **Background indexing**: uploads are processed by a durable MongoDB-backed job queue with progress updates, retries and crash recovery
- **Threaded conversations**: create, view and delete multiple chat threads, each with its own history and documents
- **Conversation memory**: recent history is sent to the model, trimmed to a token budget
- **Usage limits**: 20 free messages per account, enforced atomically, with a gated Premium upgrade flow
- **Rate limiting**: per-IP and per-user limits on auth, chat and upload endpoints
- **Light / dark theme** toggle
- **Account settings**: update username, email and password from the app
- **Automated CI/CD**: tests, lint, build and Docker image checks on every push, with automatic deploy to Render

## Tech Stack

**Frontend**
- React 19 + Vite
- `react-markdown` + `rehype-highlight` for rendering assistant responses
- `react-spinners` for loading states

**Backend**
- Node.js 22 + Express
- MongoDB + Mongoose
- JSON Web Tokens (`jsonwebtoken`) and `bcryptjs`
- Google Gemini API (`@google/genai`) for chat and embeddings
- `pdfjs-dist` for PDF text extraction, `multer` for uploads
- `express-rate-limit` for rate limiting

**DevOps**
- GitHub Actions (CI and CD)
- Docker and Docker Compose
- Deployed on Render

## Architecture

```
┌────────────┐   HTTPS / SSE    ┌──────────────────┐        ┌──────────────┐
│  React app │ ───────────────▶ │  Express API     │ ─────▶ │  Gemini API  │
│  (Vite)    │ ◀─────────────── │  (auth, chat,    │        │ chat + embed │
└────────────┘                  │   documents)     │        └──────────────┘
                                └────────┬─────────┘
                                         │ Mongoose
                                ┌────────▼─────────┐        ┌──────────────┐
                                │     MongoDB      │ ◀───── │ Doc worker   │
                                │ users, threads,  │  jobs  │ extract →    │
                                │ documents,       │        │ chunk →      │
                                │ chunks + vectors,│        │ embed        │
                                │ upload jobs      │        └──────────────┘
                                └──────────────────┘
```

The document worker runs inside the API process by default. For heavier use, set `RUN_WORKER_IN_API=false` and run `npm run worker` as a separate service so PDF parsing never competes with request handling.

## Project Structure

```
SigmaGPT_Project/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # tests, lint, build, Docker check
│   │   └── cd.yml                 # push images + deploy to Render
│   └── dependabot.yml             # weekly dependency updates
├── Backend/
│   ├── server.js                  # entry point: DB connect, server + worker start
│   ├── app.js                     # Express app: CORS, parsers, routes, error handling
│   ├── worker.js                  # standalone document-indexing worker
│   ├── Dockerfile
│   ├── routes/
│   │   ├── auth.js                # signup, login, profile, upgrade, user count
│   │   ├── chat.js                # threads CRUD + streaming chat endpoint
│   │   └── documents.js           # upload, status, list, delete documents
│   ├── models/                    # User, Thread, Document, DocumentChunk, UploadJob
│   ├── middlewares/               # authMiddleware, rateLimit
│   ├── utils/                     # gemini, embeddings, chunker, retrieval, textExtractor
│   ├── workers/documentWorker.js  # job queue consumer with leases and retries
│   ├── scripts/createVectorIndex.js  # one-time Atlas Vector Search index setup
│   ├── eval/                      # RAG evaluation harness (see eval/README.md)
│   └── tests/                     # node:test suites + fake DB helpers
├── Frontend/
│   ├── Dockerfile, nginx.conf
│   └── src/
│       ├── App.jsx                # root component / auth gate
│       ├── AuthPage.jsx           # login / signup UI
│       ├── AuthContext.jsx        # auth state, token storage, API calls
│       ├── ThemeContext.jsx       # light/dark theme provider
│       ├── MyContext.jsx          # shared chat state
│       ├── Sidebar.jsx            # thread list and navigation
│       ├── ChatWindow.jsx         # chat UI, streaming, settings/upgrade modals
│       ├── Chat.jsx               # message rendering
│       ├── AttachMenu.jsx         # image and document attachment menu
│       └── config.js              # API base URL (VITE_API_URL)
├── Images/                        # README screenshots
├── docker-compose.yml             # local full stack: Mongo + API + worker + frontend
└── README.md
```

## Getting Started

### Prerequisites

- Node.js **22.3 or newer**
- A MongoDB instance (local or Atlas)
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))

### 1. Clone the repository

```bash
git clone https://github.com/Priyanshu1210R/SigmaGPT_Project.git
cd SigmaGPT_Project
```

### 2. Backend setup

```bash
cd Backend
npm install
```

Create `Backend/.env`:

```env
PORT=8080
MONGODB_URL=your_mongodb_connection_string
JWT_SECRET=your_long_random_secret
GEMINI_API_KEY=your_gemini_api_key
CORS_ORIGINS=http://localhost:5173
```

Start it:

```bash
npm run dev      # with nodemon (auto-restart)
# or
npm start
```

The API runs at `http://localhost:8080`. `GET /` returns a health-check response. The server exits immediately if `MONGODB_URL`, `JWT_SECRET` or `GEMINI_API_KEY` is missing.

### 3. Frontend setup

```bash
cd Frontend
npm install
```

Create `Frontend/.env` to point at your local backend:

```env
VITE_API_URL=http://localhost:8080
```

```bash
npm run dev
```

The app runs at `http://localhost:5173`. Without `VITE_API_URL`, the deployed backend URL is used.

## Environment Variables

### Backend

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGODB_URL` | yes | n/a | MongoDB connection string |
| `JWT_SECRET` | yes | n/a | Secret used to sign JWTs |
| `GEMINI_API_KEY` | yes | n/a | Google Gemini API key |
| `PORT` | no | `8080` | HTTP port |
| `CORS_ORIGINS` | no | n/a | Comma-separated list of allowed frontend origins |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Chat model |
| `GEMINI_EMBEDDING_MODEL` | no | `gemini-embedding-001` | Embedding model |
| `EMBEDDING_DIMENSIONS` | no | `768` | Embedding vector size |
| `HISTORY_TOKEN_BUDGET` | no | `24000` | Max conversation history sent per request |
| `TRUST_PROXY` | no | `1` | Proxy hops to trust (for correct client IPs behind Render/nginx) |
| `RUN_WORKER_IN_API` | no | `true` | Set `false` to run the worker as its own process |
| `DOC_WORKER_CONCURRENCY` | no | `2` | Documents processed in parallel |
| `DOC_WORKER_POLL_MS` | no | `3000` | Job queue poll interval |
| `VECTOR_INDEX_NAME` | no | `chunk_vector_index` | Atlas Vector Search index name |
| `ENABLE_DEMO_UPGRADE` | no | `false` | Enables the demo Premium upgrade (ignored in production) |

### Frontend

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Backend base URL, baked in at build time |

> Never commit `.env` files. They are already listed in `.gitignore`.

## Running with Docker

Run the whole stack (MongoDB, API, document worker and frontend) with one command.

1. Create `Backend/.env` containing at least `JWT_SECRET` and `GEMINI_API_KEY`. `MONGODB_URL` is set by Compose.
2. From the repo root:

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:8080 |

To build the images individually:

```bash
docker build -t sigmagpt-backend ./Backend
docker build -t sigmagpt-frontend --build-arg VITE_API_URL=http://localhost:8080 ./Frontend
```

The backend image runs as a non-root user and exposes a health check on `GET /`. The frontend is built with Vite and served by nginx.

## API Overview

All `/api/...` routes below the auth endpoints need an `Authorization: Bearer <token>` header.

### Auth

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| POST | `/api/auth/signup` | Register a new user | No |
| POST | `/api/auth/login` | Log in and receive a JWT | No |
| GET | `/api/auth/me` | Get the current user's profile | Yes |
| PUT | `/api/auth/update-profile` | Update username, email or password | Yes |
| POST | `/api/auth/upgrade` | Disabled (501) unless `ENABLE_DEMO_UPGRADE=true` outside production | Yes |
| GET | `/api/auth/users-count` | Total registered users | Yes |

### Chat

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| GET | `/api/thread` | List the user's threads | Yes |
| GET | `/api/thread/:threadId` | Get one thread | Yes |
| DELETE | `/api/thread/:threadId` | Delete a thread | Yes |
| POST | `/api/chat` | Send a message (and optional image); response streams back over SSE | Yes |

### Documents

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| GET | `/api/documents/:threadId` | List documents in a thread | Yes |
| POST | `/api/documents/:threadId/upload` | Upload a PDF, TXT or Markdown file (max 15 MB) | Yes |
| GET | `/api/documents/:threadId/:documentId/status` | Poll indexing status and progress | Yes |
| DELETE | `/api/documents/:threadId/:documentId` | Delete a document and its chunks | Yes |

## Document Q&A (RAG)

1. **Upload**: a file is validated and stored with a job in MongoDB (limits: 15 MB per file, 20 documents per thread, 5 active jobs per user).
2. **Index**: the worker extracts text (PDF via `pdfjs-dist`), splits it into overlapping, paragraph-aware chunks (about 1,200 characters, 150 overlap), and embeds them with `gemini-embedding-001`. Progress is reported to the UI. Failed jobs retry with backoff, and jobs orphaned by a crash or redeploy are re-claimed automatically.
3. **Retrieve**: on each question the query is embedded and the top 5 chunks are fetched, scoped to the current user and thread. Atlas `$vectorSearch` is used when available, with an automatic in-process cosine-similarity fallback.
4. **Answer**: the chunks are added to the prompt as numbered context, and Gemini cites them inline.

### Atlas Vector Search (optional)

For production-scale retrieval, create the vector index once on an Atlas cluster (M10+ or Flex/Serverless; not available on free M0):

```bash
cd Backend
node scripts/createVectorIndex.js
```

Without the index (for example local MongoDB), retrieval still works through the fallback, just more slowly on large collections.

## RAG Evaluation

A repeatable harness in `Backend/eval/` scores retrieval (Hit@k, MRR, Recall@k) and answer grounding on a fixed 20-question set, with an offline BM25 baseline for comparison.

```bash
cd Backend
npm run eval              # full run: retrieval + answers + LLM-judged scoring
npm run eval:retrieval    # retrieval only (cheapest)
npm run eval:baseline     # offline BM25 baseline, no API key needed
```

See [`Backend/eval/README.md`](Backend/eval/README.md) for methodology, flags and metrics.

## Usage Limits & Rate Limits

- **Free accounts** are capped at **20 messages**. The cap is enforced with an atomic database update, so parallel requests can't exceed it, and a failed AI call refunds the message. At the limit, `/api/chat` returns `403` with `FREE_LIMIT_REACHED`.
- **Premium** is not wired to a payment provider. `/api/auth/upgrade` is disabled by default; connect it to a verified payment webhook before enabling Premium for real users.
- **Rate limits**:
  - Per IP: 600 requests / 15 min overall, 10 failed logins / 15 min, 5 signups / hour
  - Per user: 10 chat messages / minute, plus a separate limit on uploads

## Testing

Backend tests use Node's built-in test runner with an in-memory fake DB and mocked Gemini, so no database or API key is needed.

```bash
cd Backend
npm test                 # all tests
npm run test:routes      # route tests only
```

Frontend:

```bash
cd Frontend
npm run lint
npm run build
```

## CI/CD

Two GitHub Actions workflows in `.github/workflows/`:

**CI** (`ci.yml`) runs on every pull request and every push to `main`:
1. Backend: `npm ci` then `npm test`
2. Frontend: `npm run lint` then `npm run build`
3. Docker: builds the backend and frontend images to catch Dockerfile breakage

**CD** (`cd.yml`) runs after CI succeeds on `main`:
1. Builds and pushes both images to GitHub Container Registry (`ghcr.io`), tagged `latest` and with the commit SHA
2. Triggers a Render deploy through deploy hooks

### Setup for deployment

In the GitHub repo, go to **Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|---|---|---|
| `RENDER_BACKEND_DEPLOY_HOOK` | Secret | Deploy hook URL of the backend service |
| `RENDER_FRONTEND_DEPLOY_HOOK` | Secret | Deploy hook URL of the frontend service |
| `RENDER_WORKER_DEPLOY_HOOK` | Secret (optional) | Deploy hook URL of a separate worker service |
| `VITE_API_URL` | Variable | Public backend URL, baked into the frontend image |

On each Render service, copy the hook from **Settings → Deploy Hook** and set **Auto-Deploy to Off** so deploys only happen after tests pass. A hook with no secret is skipped.

**Recommended:** enable branch protection on `main` and require the CI jobs to pass before merging.

## Screenshots

| | |
|---|---|
| ![Chat response with sliding window explanation](Images/Screenshot%202026-08-14%20190948.png) | ![Account menu with settings, upgrade plan, and users](Images/Screenshot%202026-08-14%20190739.png) |
| ![Thread list with delete option, light mode](Images/Screenshot%202026-08-14%20190722.png) | ![Start a new chat, dark mode](Images/Screenshot%202026-08-14%20190701.png) |

## License

No license specified yet. Add one (for example MIT) if you plan to share or open-source this project.
