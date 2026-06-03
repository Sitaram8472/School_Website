# 🎓 EduStream Academy Portal

EduStream is a comprehensive Full-Stack Academic Management Portal designed to bridge the gap between students, faculty, and administration. Built with the **MERN Stack (MongoDB, Express.js, React.js, Node.js)**, it features real-time notice boards, academic resource sharing, and an AI-integrated support system for student inquiries.

---

## 🚀 Features

### 📢 Real-Time Notice Board

* Dynamic announcements fetched from the database.
* Instant updates for students and faculty.

### 📚 Academic Resource Hub

* Centralized repository for course materials and STEM excellence programs.
* Easy access to academic resources.

### 🤖 AI Support Integration

* Powered by the Gemini API.
* Handles admission and academic queries instantly.

### 🏫 Infinite Campus Gallery

* High-performance CSS-animated marquee.
* Showcases campus life and activities.

### 🎨 Professional UI

* Fully responsive design.
* Built with Tailwind CSS and Lucide React Icons.

---

## 🛠️ Tech Stack

### Frontend

* React.js
* Vite
* Tailwind CSS
* Axios

### Backend

* Node.js
* Express.js

### Database

* MongoDB

### AI Integration

* Gemini API

---

## 📂 Project Structure

```bash
SCHOOL_WEBSITE/
│
├── backend/                 # Node.js & Express Server
│   ├── config/              # Database Connection Logic
│   ├── controllers/         # Business Logic
│   ├── routes/              # API Endpoints
│   └── server.js            # Entry Point
│
├── frontend/                # React & Vite Application
│   ├── src/
│   │   ├── api/             # Axios Configurations
│   │   ├── components/      # Reusable UI Components
│   │   └── data/            # Static Data & State Management
│
└── .env                     # Environment Variables
```

---

## ⚙️ Setup & Installation

### Prerequisites

Make sure you have the following installed:

* Node.js (v18+)
* MongoDB
* npm (Node Package Manager)

---

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/Sitaram8472/School_Website.git
cd School_Website
```

---

### 2️⃣ Backend Setup

Navigate to the backend folder:

```bash
cd backend
```

Install dependencies:

```bash
npm install
```

Create a `.env` file inside the backend directory and add the required environment variables:

```env
MONGODB_URI=your_mongodb_connection_string
PORT=5000
GEMINI_API_KEY=your_gemini_api_key
```

Start the backend server:

```bash
npm run dev
```

---

### 3️⃣ Frontend Setup

Navigate to the frontend folder:

```bash
cd ../frontend
```

Install dependencies:

```bash
npm install
```

Start the React application:

```bash
npm run dev
```

---

## 🤝 Contribution Guide

We welcome contributions from the community!

### Steps to Contribute

1. Fork the repository.
2. Create a feature branch:

```bash
git checkout -b feature/AmazingFeature
```

3. Commit your changes:

```bash
git commit -m "Add AmazingFeature"
```

4. Push to your branch:

```bash
git push origin feature/AmazingFeature
```

5. Open a Pull Request.

---

## 🌟 Support

If you find this project useful, don't forget to give it a ⭐ on GitHub.

Happy Coding! 🚀
