/**
 * Quick RBAC smoke test. Run: node scripts/testRbac.js
 */

const accounts = [
  { label: "student", email: "student@test.com", password: "test123" },
  { label: "teacher", email: "teacher@test.com", password: "test123" },
  { label: "admin", email: "admin@test.com", password: "test123" },
];

async function request(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`http://localhost:5000/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

async function login(email, password) {
  const res = await fetch("http://localhost:5000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  const data = await res.json();
  return { status: res.status, role: data?.user?.role, cookie };
}

async function run() {
  console.log("RBAC API Smoke Test\n");

  for (const account of accounts) {
    const { status, role, cookie } = await login(account.email, account.password);
    console.log(`--- ${account.label} (${role}) login: ${status} ---`);

    const noticesGet = await request("/notices", { cookie });
    const noticesPost = await request("/notices", {
      method: "POST",
      cookie,
      body: { title: "Test", category: "General", content: "RBAC test" },
    });
    const appsGet = await request("/applications", { cookie });
    const teacherStats = await request("/teacher/stats", { cookie });

    console.log(`  GET /notices:        ${noticesGet} (expect 200)`);
    console.log(`  POST /notices:       ${noticesPost} (student=403, teacher/admin=201)`);
    console.log(`  GET /applications:   ${appsGet} (student/teacher=403, admin=200)`);
    console.log(`  GET /teacher/stats:  ${teacherStats} (student=403, teacher/admin=200)`);
    console.log();
  }
}

run().catch(console.error);
