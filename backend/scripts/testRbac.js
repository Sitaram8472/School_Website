const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  try {
    console.log('Testing RBAC Middleware...\n');

    // --- Helper function to login and get token ---
    const loginAndGetCookie = async (email, password) => {
      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!loginRes.ok) return null;
      const data = await loginRes.json();
      return `token=${data.token}`;
    };

    // ==========================================
    // TEST 1: STUDENT RESTRICTIONS
    // ==========================================
    console.log('--- TEST 1: Student Restrictions ---');
    console.log('1. Logging in as seeded user student@test.com...');
    const studentCookie = await loginAndGetCookie('student@test.com', 'test123');

    if (!studentCookie) {
      console.error('❌ FAIL: Test setup failed. Could not login student.');
      console.log('Please ensure the server is running and `node scripts/seedTestUsers.js` was run.');
      return;
    }

    console.log('2. Attempting to create a course as Student (Should fail with 403)...');
    const createCourseStudentRes = await fetch(`${BASE_URL}/courses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': studentCookie },
      body: JSON.stringify({ name: 'Hacking 101', description: 'Should not work' })
    });

    if (createCourseStudentRes.status === 403) {
      console.log('✅ PASS: Student correctly blocked from creating courses (403)\n');
    } else {
      console.error(`❌ FAIL: Unexpected status for student: ${createCourseStudentRes.status}\n`);
    }

    // ==========================================
    // TEST 2: TEACHER OWNERSHIP ENFORCEMENT
    // ==========================================
    console.log('--- TEST 2: Teacher Ownership Enforcement ---');
    console.log('1. Logging in as Teacher 1 (teacher@test.com)...');
    const teacherCookie = await loginAndGetCookie('teacher@test.com', 'test123');
    
    if (!teacherCookie) {
      console.error('❌ FAIL: Test setup failed. Could not login teacher@test.com.');
      return;
    }

    console.log('2. Teacher 1 creates a new dummy course...');
    const createCourseRes = await fetch(`${BASE_URL}/courses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': teacherCookie },
      body: JSON.stringify({ name: 'Teacher 1 Course', description: 'Testing RBAC' })
    });
    
    if (!createCourseRes.ok) {
      console.error('❌ FAIL: Teacher 1 failed to create course.');
      console.log('Status:', createCourseRes.status);
      console.log('Response:', await createCourseRes.text());
      return;
    }
    
    const courseData = await createCourseRes.json();
    const courseId = courseData.data._id;
    console.log(`   -> Course created with ID: ${courseId}`);

    console.log('3. Logging in as Teacher 2 (teacher2@test.com)...');
    const teacher2Cookie = await loginAndGetCookie('teacher2@test.com', 'test123');

    if (!teacher2Cookie) {
      console.log('   -> Teacher 2 login failed. Make sure to run `node scripts/seedTestUsers.js` first. Skipping ownership test.');
    } else {
      console.log('4. Attempting to DELETE Teacher 1\'s course as Teacher 2 (Should fail with 403)...');
      const deleteRes = await fetch(`${BASE_URL}/courses/${courseId}`, {
        method: 'DELETE',
        headers: { 'Cookie': teacher2Cookie }
      });

      if (deleteRes.status === 403) {
        console.log('✅ PASS: Teacher 2 correctly blocked from deleting Teacher 1\'s course (403)');
      } else {
        console.error(`❌ FAIL: Unexpected status when deleting: ${deleteRes.status}`);
      }
    }

    // Clean up
    console.log('5. Teacher 1 cleans up and deletes their own course (Should pass with 200)...');
    const cleanupRes = await fetch(`${BASE_URL}/courses/${courseId}`, {
        method: 'DELETE',
        headers: { 'Cookie': teacherCookie }
    });

    if (cleanupRes.ok) {
        console.log('✅ PASS: Teacher 1 successfully deleted their own course (200)');
    } else {
        console.error(`❌ FAIL: Teacher 1 could not delete own course. Status: ${cleanupRes.status}`);
    }

  } catch (error) {
    console.error('\nTest execution failed:', error.message);
  }
}

runTests();
