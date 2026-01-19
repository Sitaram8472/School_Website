# Contributing to CampusNotes

Thank you for considering contributing to **CampusNotes**! 🎉  
This document will guide you through the process of setting up your environment, making changes, and submitting a pull request.

---

## Project Overview

CampusNotes is an open-source platform designed to help students **share, organize, and access notes efficiently**.  
We welcome contributions of all kinds:  
- 🐞 **Bug fixes**  
- 🌟 **New features**  
- 📖 **Documentation improvements**  
- 💡 **Suggestions and feedback**  

Whether you're new to open source or an experienced developer, you can make a difference here.

---

## How to Contribute

Follow these steps to contribute to CampusNotes on **Windows, macOS, or Linux**.

---

### 1. Fork and Clone the Repository
1. Click the **Fork** button at the top-right of this repository on GitHub.  
2. Clone your fork locally:  
   ```bash
   git clone https://github.com/your-username/Campus_Notes.git
   cd CampusNotes
### 2. Install Dependencies
  We recommend using Command Prompt on Windows (instead of VS Code PowerShell if you face issues) and Terminal on macOS/Linux.
  
  **Windows**
  
  1. Open Command Prompt (cmd):
     
      • Press Win + R, type cmd, press **Enter`.
     
  2. Navigate to the project folder:
     ```bash
     cd <path\to\Campus_Notes>
     ```
  
  3. Install dependencies:
     ```bash
     npm install
     ```
   **macOS / Linux**
  
   1. Open Terminal (Cmd+Space → type "Terminal" on macOS, or Ctrl+Alt+T on Linux).
  
   2. Navigate to the project folder:
      ```bash
      cd <path\to\CampusNotes>
      ```
  
   3. Install dependencies:
      ```bash
      npm install
      ```
### 3. Create a New Branch
  Always work on a new branch instead of making changes directly on main:
  ```bash
     git checkout -b mybranch
  ```

### 4. Make Your Changes
- Follow the existing code style and conventions.

- Keep commits small and meaningful.

- If you add a feature, update documentation if needed.

### 5. Test Your Changes

Before pushing changes, test the app locally:
```bash
  npm run dev
```
Verify that your changes work as expected.

### 6. Commit and Push

Commit your work with a descriptive message:
```bash
git add .
git commit -m "Describe your changes clearly"
git push origin feature-or-fix-name
```

### 7. Open a Pull Request (PR)
- Go to your fork on GitHub.

- Click Compare & pull request.

- Add a clear title and description for your PR.

- Submit the PR — we’ll review it as soon as possible.


## After Your PR is Merged

Once your Pull Request is successfully merged, your efforts will be recognized as part of the **GirlScript Summer of Code (GSSOC)** program.  
Each PR is reviewed and assigned a **level label** that reflects its complexity and impact:

- **Level 1:** 3 Points — for small changes like fixing typos, minor bugs, or improving documentation.  
- **Level 2:** 7 Points *(may vary)* — for moderate contributions such as adding new features or improving existing ones.  
- **Level 3:** 10 Points — for major enhancements, architecture-level changes, or high-impact fixes.  

These points are **officially recorded on the GSSOC Contributor Leaderboard**, showcasing your contributions to the open-source community.  
Your name and total score will appear on the official website, helping you gain **recognition among peers, mentors, and potential recruiters**.  

**Contributing is not just about earning points — it’s about learning, collaborating, and leaving a lasting impact on the project!..**

---

### Tips for Successful Contributions
- Keep PRs focused: Avoid mixing unrelated changes.

- Sync with upstream: Before starting work, always update your fork:
```bash
git checkout main
git pull upstream main
git push origin main
```
- Ask questions: If you’re unsure, open an issue or discussion first.
- Thank you for visting.
---


**Thanks again for contributing! 🙌 Your help makes CampusNotes better for everyone**.