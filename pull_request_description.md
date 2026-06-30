# Pull Request: Full-Stack Upgradation (Auth Routing, Dynamic Notices, and AI Chatbot)

## Associated Issue
Closes #[Insert Issue Number]

## Type of Change
- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [x] Refactoring & optimization

## Detailed Description of Changes

### 1. Backend Upgrades & Bug Fixes
* **Notice Board Schema & Controller**:
  - Created [Notice.js](file:///c:/ssoc/School_Website-main/backend/models/Notice.js) Mongoose schema.
  - Rewrote [noticeController.js](file:///c:/ssoc/School_Website-main/backend/controllers/noticeController.js) to retrieve/create notices from MongoDB with auto-seeding.
  - Mounted routes under `/api/notices` in [server.js](file:///c:/ssoc/School_Website-main/backend/server.js) and removed duplicate require statements.
* **Role-Based Auth**:
  - Added `role` to [User.js](file:///c:/ssoc/School_Website-main/backend/models/User.js).
  - Updated [Authcontroller.js](file:///c:/ssoc/School_Website-main/backend/controllers/Authcontroller.js) register and login endpoints to handle and return roles.

### 2. Frontend Routing & UX Polish
* **Router Mapping**:
  - Mapped `/login`, `/register`, and role-based versions `/login/:role`, `/register/:role` in [App.jsx](file:///c:/ssoc/School_Website-main/frontend/src/App.jsx).
* **Stateful Navbar**:
  - Modified [Navbar.jsx](file:///c:/ssoc/School_Website-main/frontend/src/components/Navbar.jsx) to consume `AuthContext`.
  - Shows dynamic profile link and Sign Out options instead of login links when authenticated.
* **Dynamic Student Dashboard & Notices**:
  - Updated student dashboard [Student.jsx](file:///c:/ssoc/School_Website-main/frontend/src/pages/Student.jsx) to show user name dynamically.
  - Updated [Notices.jsx](file:///c:/ssoc/School_Website-main/frontend/src/data/Notices.jsx) and [Home.jsx](file:///c:/ssoc/School_Website-main/frontend/src/pages/Home.jsx) to render dynamic notices as cards.

### 3. Floating AI Support Chatbot
* **Interactive AI Assistant**:
  - Created [Chatbot.jsx](file:///c:/ssoc/School_Website-main/frontend/src/components/Chatbot.jsx) floating chatbot, utilizing the Gemini AI API via [geminiService.js](file:///c:/ssoc/School_Website-main/frontend/src/services/geminiService.js).
  - Features sliding chat window, message list, typing indicators, and auto-scroll.

---

## How to Test
1. Set up backend `.env` variables (`MONGO_URL`, `JWT_SECRET`, `PORT`).
2. Start the backend: `npm run dev` in `backend`.
3. Start the frontend: `npm run dev` in `frontend`.
4. Click **Get Started** in the Navbar, select **As Student**, sign up, and log in. Verify redirection to `/student` and check the updated Navbar options.
5. Verify the **Notice Board** on the homepage loads notices dynamically from MongoDB.
6. Click the floating robot bubble in the bottom right, type a question, and verify the Gemini AI response.
