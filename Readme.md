# 🎓 EduStream Academy Portal
* EduStream is a comprehensive Full-Stack Academic Management Portal designed to bridge the gap between students, faculty, and administration. Built with the MERN stack (MySQL, Express, React, Node.js), it features real-time notice boards, academic resource sharing, and an AI-integrated support system for student inquiries.

---

## 🚀 Features

- **Real-time Notice Board:** -  Dynamic announcements fetched from a MySQL database.
- **Academic Resource Hub:** Centralized repository for course materials and STEM excellence programs.  
- **AI Support Integration:** Powered by the Gemini API to handle admission and academic queries instantly.
- **Infinite Campus Gallery:** A high-performance, CSS-animated marquee showcasing campus life.
- **Professional UI:** Fully responsive design built with Tailwind CSS and Lucide-React icons.

---

## 🛠️ Tech Stack

- **Frontend:** React.js, Vite, Tailwind CSS, Axios.
- **Backend:** Node.js, Express.js.
- **Database:** MySQL (Relational data management).
- **AI:** Gemini AI Service integration.

---

## 🎯 Example User Flow

1. **Select College** → e.g. *JIS College of Engineering*  
2. **Choose Department** → e.g. *IT Department*  
3. **Pick Subject/Semester** → e.g. *Data Structures – Semester 3*  
4. **Access Resources** → *Notes, Question Papers, PDFs*  

---

- # 📂 Project Structure

SCHOOL_WEBSITE/
├── backend/              # Node.js & Express server
│   ├── config/           # SQL Database connection logic
│   ├── controllers/      # Business logic & SQL Queries
│   ├── routes/           # API Endpoints
│   └── server.js         # Entry point
├── frontend/             # React & Vite application
│   ├── src/
│   │   ├── api/          # Axios configurations
│   │   ├── components/   # Reusable UI components
│   │   └── data/         # Static data & State management
└── .env                  # Environment variables (DB credentials)
---

## ⚙️ Setup & Installation

### Prerequisites

- Node.js (v18+)
- MySQL Server
- npm (Node Package Manager)

### Installation

Follow these steps to set up and run CampusNotes locally:

 1. **Clone the Repository**
    ```bash
    git clone https://github.com/Sitaram8472/School_Website
    cd School_Website
    ```

 2. **Backend Setup**

    - Navigate to the backend folder: cd backend.
    - Install dependencies: npm install.
    - Create a .env file in the backend folder and add your credentials:

    DB_HOST=localhost
    DB_USER=root
    DB_PASSWORD=your_password
    DB_NAME=school_db
    PORT=5000
    
    - Start the server: npm run dev.

 3. **Frontend Setup**
    - Navigate to the frontend folder: cd ../frontend.
    - Install dependencies: npm install.
    - Start the React app: npm run dev.

4. **🤝 Contribution Guide**
    - We welcome contributions from the community! To start contributing:
    - Fork the project.
    - Create your Feature Branch: git checkout -b feature/AmazingFeature.
    - Commit your Changes: git commit -m 'Add some AmazingFeature'.
    - Push to the Branch: git push origin feature/AmazingFeature.
    - Open a Pull Request.
