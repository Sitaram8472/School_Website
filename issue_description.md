# Issue: Refactor Authentication Routing, Notice Board, and Integrate AI Chatbot Assistant

## Description
The current EduStream Academy Portal contains several critical bugs and incomplete modules that prevent users from reaching their dashboards, dynamically loading campus notices, and using the built-in Gemini support system.

### Problems Identified:
1. **Broken Notice Board**:
   - The backend `noticeController` was attempting SQL database queries via a non-existent `config/db` module.
   - However, the rest of the backend uses MongoDB and Mongoose.
   - The notices were not mounted at `/api/notices` in `server.js`.
   - The frontend notice board displayed static placeholder data instead of fetching notices from the server.

2. **Unreachable Login & Register Pages**:
   - The React routes for `/login`, `/register`, `/login/:role`, and `/register/:role` were missing in `App.jsx`.
   - Clicking "Get Started" in the navigation bar resulted in a 404 Not Found error.

3. **Incomplete Role-Based Flow**:
   - User database documents did not have a `role` field.
   - The login/register flows were not role-aware, and logged-in users were redirected to a non-existent `/dashboard` route instead of `/student` or `/teacher`.
   - The `Navbar` was not consuming `AuthContext` to conditionally render user profile information and logout options.

4. **Missing AI Assistant Integration**:
   - Although the `geminiService.js` was defined, there was no interactive visual AI chatbot interface for visitors/students to communicate with.

---

## Proposed Solution & Upgradations:
- **Backend Refactoring**:
  - Implement a `Notice` mongoose schema and rewrite `noticeController` to perform MongoDB queries.
  - Set up notices auto-seeding on server start.
  - Mount notice routes in `server.js` and clean up duplicate imports.
  - Add a `role` field to `User` schema.
- **Routing & Auth Polish**:
  - Wire up all missing login and register routes in `App.jsx`.
  - Pass role parameter during registration and login, and redirect dynamically.
  - Connect Navbar to `AuthContext` so authenticated users see "Hi, [Name]" and dashboard links, with a functional "Sign Out" button.
- **Dynamic Notice Board**:
  - Update frontend notices component to query the dynamic endpoint.
  - Connect homepage notice board to the dynamic Notices component using consistent `Card` styles.
- **Gemini Chatbot integration**:
  - Develop a premium floating AI chatbot component that persists globally and integrates with `geminiService.js`.
