// import React, { useState } from "react";
// import api from "../utils/axios";

// const Application = () => {
//   const [formData, setFormData] = useState({
//     studentName: "",
//     email: "",
//     phone: "",
//     dateOfBirth: "",
//     grade: "",
//     parentName: "",
//     address: "",
//   });

//   const [message, setMessage] = useState("");

//   const handleChange = (e) => {
//     setFormData({
//       ...formData,
//       [e.target.name]: e.target.value,
//     });
//   };

//   const handleSubmit = async (e) => {
//     e.preventDefault();

//     try {
//       const res = await api.post(
//         "/applications",
//         formData
//       );

//       setMessage(res.data.message);

//       setFormData({
//         studentName: "",
//         email: "",
//         phone: "",
//         dateOfBirth: "",
//         grade: "",
//         parentName: "",
//         address: "",
//       });
//     } catch (error) {
//       setMessage("Failed to submit application");
//     }
//   };

//   return (
//     <div className="max-w-4xl mx-auto py-16 px-4">
//       <h1 className="text-4xl font-bold text-center mb-10">
//         Admission Application
//       </h1>

//       {message && (
//         <div className="mb-6 p-4 bg-green-100 text-green-700 rounded">
//           {message}
//         </div>
//       )}

//       <form
//         onSubmit={handleSubmit}
//         className="space-y-5"
//       >
//         <input
//           type="text"
//           name="studentName"
//           placeholder="Student Name"
//           value={formData.studentName}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <input
//           type="email"
//           name="email"
//           placeholder="Email"
//           value={formData.email}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <input
//           type="text"
//           name="phone"
//           placeholder="Phone Number"
//           value={formData.phone}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <input
//           type="date"
//           name="dateOfBirth"
//           value={formData.dateOfBirth}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <input
//           type="text"
//           name="grade"
//           placeholder="Applying For Grade"
//           value={formData.grade}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <input
//           type="text"
//           name="parentName"
//           placeholder="Parent Name"
//           value={formData.parentName}
//           onChange={handleChange}
//           required
//           className="w-full border p-3 rounded"
//         />

//         <textarea
//           name="address"
//           placeholder="Address"
//           value={formData.address}
//           onChange={handleChange}
//           required
//           rows={4}
//           className="w-full border p-3 rounded"
//         />

//         <button
//           type="submit"
//           className="bg-blue-600 text-white px-8 py-3 rounded-lg"
//         >
//           Submit Application
//         </button>
//       </form>
//     </div>
//   );
// };

// export default Application;

import React, { useState } from "react";
import api from "../utils/axios";

const initialForm = {
  studentName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  grade: "",
  parentName: "",
  address: "",
};

const Application = () => {
  const [formData, setFormData] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    let { name, value } = e.target;

    if (name === "phone") {
      value = value.replace(/\D/g, "");
    }

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    setErrors((prev) => ({
      ...prev,
      [name]: "",
    }));
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.studentName.trim()) {
      newErrors.studentName = "Student name is required";
    } else if (formData.studentName.trim().length < 3) {
      newErrors.studentName =
        "Student name must be at least 3 characters";
    }

    if (!formData.parentName.trim()) {
      newErrors.parentName = "Parent name is required";
    }

    if (!formData.email.trim()) {
      newErrors.email = "Email address is required";
    } else if (
      !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(
        formData.email
      )
    ) {
      newErrors.email = "Enter a valid email address";
    }

    if (!formData.phone.trim()) {
      newErrors.phone = "Phone number is required";
    } else if (!/^[6-9]\d{9}$/.test(formData.phone)) {
      newErrors.phone =
        "Enter a valid 10-digit mobile number";
    }

    if (!formData.dateOfBirth) {
      newErrors.dateOfBirth = "Date of birth is required";
    } else {
      const dob = new Date(formData.dateOfBirth);
      const today = new Date();

      let age =
        today.getFullYear() - dob.getFullYear();

      const monthDifference =
        today.getMonth() - dob.getMonth();

      if (
        monthDifference < 0 ||
        (monthDifference === 0 &&
          today.getDate() < dob.getDate())
      ) {
        age--;
      }

      if (age < 4) {
        newErrors.dateOfBirth =
          "Student must be at least 4 years old";
      }
    }

    if (!formData.grade) {
      newErrors.grade = "Please select a grade";
    }

    if (!formData.address.trim()) {
      newErrors.address = "Address is required";
    } else if (formData.address.trim().length < 10) {
      newErrors.address =
        "Address must be at least 10 characters";
    }

    setErrors(newErrors);

    return Object.keys(newErrors).length === 0;
  };

  const inputClass = (field) =>
    `w-full rounded-lg border px-4 py-3 focus:outline-none focus:ring-2 transition ${
      errors[field]
        ? "border-red-500 focus:ring-red-200"
        : "border-slate-300 focus:ring-blue-200"
    }`;

  const handleSubmit = async (e) => {
    e.preventDefault();

    setMessage("");

    if (!validateForm()) return;

    try {
      setLoading(true);

      const res = await api.post(
        "/applications",
        formData
      );

      setSuccess(true);
      setMessage(
        res.data.message ||
          "Application submitted successfully."
      );

      setFormData(initialForm);
      setErrors({});
    } catch (error) {
      setSuccess(false);
      setMessage(
        error.response?.data?.message ||
          "Failed to submit application."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-50 min-h-screen py-16 px-4">
      <div className="max-w-4xl mx-auto bg-white shadow-lg rounded-3xl p-8 md:p-12">
        <h1 className="text-4xl font-bold text-center text-slate-900 mb-3">
          Admission Application
        </h1>

        <p className="text-center text-slate-500 mb-10">
          Complete the form below to apply for admission.
        </p>

        {message && (
          <div
            className={`mb-8 rounded-lg p-4 ${
              success
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-700"
            }`}
          >
            {message}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <label
                htmlFor="studentName"
                className="block mb-2 font-medium text-slate-700"
              >
                Student Name *
              </label>

              <input
                id="studentName"
                name="studentName"
                type="text"
                value={formData.studentName}
                onChange={handleChange}
                className={inputClass("studentName")}
              />

              {errors.studentName && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.studentName}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="parentName"
                className="block mb-2 font-medium text-slate-700"
              >
                Parent / Guardian Name *
              </label>

              <input
                id="parentName"
                name="parentName"
                type="text"
                value={formData.parentName}
                onChange={handleChange}
                className={inputClass("parentName")}
              />

              {errors.parentName && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.parentName}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="email"
                className="block mb-2 font-medium text-slate-700"
              >
                Email Address *
              </label>

              <input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                className={inputClass("email")}
              />

              {errors.email && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.email}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="phone"
                className="block mb-2 font-medium text-slate-700"
              >
                Mobile Number *
              </label>

              <input
                id="phone"
                name="phone"
                type="tel"
                maxLength={10}
                value={formData.phone}
                onChange={handleChange}
                className={inputClass("phone")}
              />

              {errors.phone && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.phone}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="dateOfBirth"
                className="block mb-2 font-medium text-slate-700"
              >
                Date of Birth *
              </label>

              <input
                id="dateOfBirth"
                name="dateOfBirth"
                type="date"
                value={formData.dateOfBirth}
                onChange={handleChange}
                className={inputClass("dateOfBirth")}
              />

              {errors.dateOfBirth && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.dateOfBirth}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="grade"
                className="block mb-2 font-medium text-slate-700"
              >
                Applying For Grade *
              </label>

              <select
                id="grade"
                name="grade"
                value={formData.grade}
                onChange={handleChange}
                className={inputClass("grade")}
              >
                <option value="">
                  Select Grade
                </option>

                {[...Array(12)].map((_, i) => (
                  <option
                    key={i + 1}
                    value={`Grade ${i + 1}`}
                  >
                    Grade {i + 1}
                  </option>
                ))}
              </select>

              {errors.grade && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.grade}
                </p>
              )}
            </div>
          </div>

          <div>
            <label
              htmlFor="address"
              className="block mb-2 font-medium text-slate-700"
            >
              Residential Address *
            </label>

            <textarea
              id="address"
              name="address"
              rows="4"
              value={formData.address}
              onChange={handleChange}
              className={inputClass("address")}
            />

            {errors.address && (
              <p className="mt-1 text-sm text-red-600">
                {errors.address}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading
              ? "Submitting Application..."
              : "Submit Application"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Application;

