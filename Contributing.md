# Social Summer of Code (SSoC) Project

## Contribution Levels

### Level Distribution
* 🟢 Easy Level: **20 points**
* 🟡 Medium Level: **30 points**
* 🔴 Hard Level: **40 points**

> **Note:** Please wait for the official level assignment. The project maintainers will update the difficulty level and corresponding contribution points.

## How to Contribute

1. Fork the repository.
2. Clone your fork locally.
3. Create a new branch for your changes.
4. Make your contribution.
5. Commit your changes following **Conventional Commits** format (see below).
6. Push your changes.
7. Create a Pull Request (PR).

## Contribution Guidelines

* Follow the project's coding standards.
* Write clear and descriptive commit messages using **Conventional Commits**.
* Test your changes before submitting.
* Ensure your PR description explains the changes made.

## Conventional Commits

We follow the **Conventional Commits** specification for all commit messages. This ensures clear, readable history and enables automated changelog generation.

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

* **feat**: A new feature
* **fix**: A bug fix
* **docs**: Documentation only changes
* **style**: Changes that don't affect code meaning (formatting, whitespace, etc.)
* **refactor**: Code changes that neither fix bugs nor add features
* **perf**: Code changes that improve performance
* **test**: Adding missing tests or correcting existing tests
* **chore**: Changes to build process, dependencies, or other non-code changes
* **ci**: Changes to CI/CD configuration files and scripts

### Scope (Optional)

Scope specifies what area of the codebase is affected:
* `frontend`, `backend`, `auth`, `database`, `api`, etc.

### Subject

* Use imperative mood: "add" not "added" or "adds"
* Don't capitalize first letter
* No period at the end
* Limit to 50 characters
* Be specific and descriptive

### Body (Optional)

* Explain **what** and **why**, not how
* Wrap at 72 characters
* Separate from subject by blank line
* Use bullet points for multiple changes

### Footer (Optional)

* Reference issue numbers: `Fixes #123`
* Reference breaking changes: `BREAKING CHANGE: description`

---

## Good Commit Messages ✅

### Example 1: Simple Feature
```
feat(frontend): add dark mode toggle button

Users can now switch between light and dark themes using
the toggle button in the navbar. Theme preference is saved
to localStorage.

Fixes #45
```

### Example 2: Bug Fix
```
fix(backend): correct user authentication token expiry

Token expiry check was using <= instead of <, causing
tokens to expire one second earlier than intended.

Fixes #78
```

### Example 3: Refactoring
```
refactor(frontend): extract login form to separate component

Move login form logic from auth page to reusable LoginForm
component to reduce code duplication and improve testability.
```

### Example 4: Documentation
```
docs: update API endpoint documentation

Add request/response examples and clarify authentication
requirements for the user profile endpoint.
```

### Example 5: Multiple Changes
```
feat(database): add user preferences table

- Create preferences table with user_id foreign key
- Add default preferences initialization on user signup
- Add migration script for existing users

Fixes #92
```

---

## Bad Commit Messages ❌

### ❌ Too Vague
```
fix: stuff
update: things
changes: code
```
**Problem:** Unclear what was actually changed.

### ❌ Missing Type
```
added new button to navbar
fixed auth issue
```
**Problem:** No commit type prefix makes history hard to scan.

### ❌ Imperative vs Past Tense
```
feat(frontend): Added user profile page
feat(frontend): Adds navigation menu
```
**Problem:** Should use imperative mood: "add" not "added" or "adds".

### ❌ Too Long Subject
```
feat(frontend): implement a comprehensive user authentication system with login, signup, password reset, and email verification features
```
**Problem:** Subject should be ≤50 characters. Use body for details.

### ❌ No Scope
```
fix: token validation
feat: new API endpoint
```
**Problem:** Unclear which part of the codebase is affected. Add scope: `fix(backend): ...`

### ❌ Unclear Body
```
fix(auth): fixed the login bug

did a bunch of changes to make it work. not sure what
the exact issue was but it works now
```
**Problem:** Doesn't explain the root cause or what was changed.

---

## Tips for Great Commits

1. **Atomic commits**: Each commit should represent one logical change
2. **Frequent commits**: Commit regularly, don't wait until the end
3. **Review before committing**: Use `git diff` to verify changes
4. **Keep history clean**: Use conventional commits to maintain readable history
5. **Link to issues**: Reference issue numbers in commit footer

## Support

If you have any questions about commit formats or contributing, feel free to open an issue or contact the maintainers.

Happy Contributing! 