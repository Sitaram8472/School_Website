# 🎓 EduStream Academy - Modern School Management System

EduStream Academy is a fully responsive, modern educational platform built with **React.js** and **Tailwind CSS**. It features a dynamic notice board, academic program listings, an automated admissions timeline, and an **AI-powered inquiry assistant** integrated with Google Gemini.



---

## 🚀 Features

- **🏠 Home Page**: Showcases school statistics, featured faculty, and a real-time notice board.
- **📖 Academic Programs**: Detailed curriculum paths for STEM, Arts, Business, and Humanities.
- **📅 Admissions Portal**: A visual step-by-step enrollment timeline and academic calendar.
- **🤖 AI Assistant**: A built-in "Fast Inquiry" chatbot powered by Google Gemini AI to answer student questions instantly.
- **📱 Fully Responsive**: Optimized for mobile, tablet, and desktop using Tailwind's mobile-first grid system.
- **🗺️ Smooth Routing**: Client-side navigation powered by `react-router-dom` with automatic scroll-to-top logic.

---

## 🛠️ Tech Stack

- **Frontend**: React.js (v18+)
- **Styling**: Tailwind CSS
- **Routing**: React Router (HashRouter for stable deployment)
- **AI Integration**: Google Generative AI (Gemini API)
- **Animations**: Tailwind CSS Animate / Framer Motion logic

---

## 💻 Installation & Setup

Follow these steps to run the project locally on your machine.

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed (v16 or higher recommended).

### 2. Clone the Repository
```bash
git clone [https://github.com/your-username/edustream-academy.git](https://github.com/your-username/edustream-academy.git)
cd edustream-academy

3. Install Dependencies
Bash
npm install
4. Set Up Environment Variables
Create a .env file in the root directory and add your Gemini API key:

Code snippet
REACT_APP_GEMINI_API_KEY=your_google_gemini_api_key_here
5. Run the Application
Bash
npm start
The app will be available at http://localhost:3000.

📂 Project Structure
Plaintext
src/
├── components/       # Reusable UI (Navbar, Footer, Card, Hero)
├── pages/            # Page-level components (Home, About, etc.)
├── services/         # API logic (Gemini AI Service)
├── data/             # Static JSON-style data (Teachers, Notices)
├── App.js            # Main Routing Logic
└── index.js          # Entry Point
🤝 Contributing
We love contributions! Whether it's fixing a bug or adding a new feature, please follow these steps:

Fork the project.

Create your Feature Branch (git checkout -b feature/AmazingFeature).

Commit your changes (git commit -m 'Add some AmazingFeature').

Push to the Branch (git push origin feature/AmazingFeature).

Open a Pull Request.

🏆 GSSOC Contributors
This project is part of the GirlScript Summer of Code.

Level 1: 3 Points (Typo fixes, Documentation)

Level 2: 7 Points (UI improvements, New Sections)

Level 3: 10 Points (New features, AI logic optimization)

📄 License
Distributed under the MIT License. See LICENSE for more information.

📞 Contact
EduStream Academy Office 📧 Email: office@edustream.edu

🌐 Website: www.edustream-academy.com

"Developing tomorrow's leaders through integrity and innovation."


---

### How to use this:
1. Create a new file in your project's root folder called `README.md`.
2. Copy the code above and paste it into that file.
3. Replace the placeholder links (like `your-username`) with your actual GitHub details.

**Would you like me to help you write a `package.json` file to make sure all the depen

```