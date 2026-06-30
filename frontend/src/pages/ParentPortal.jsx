import notices from "../data/Notices";

export default function ParentPortal() {
  return (
    <div className="max-w-6xl mx-auto py-12 px-6">

      <h1 className="text-4xl font-bold mb-10 text-center">
        Parent Portal
      </h1>

      {/* Attendance */}
      <div className="bg-white shadow-lg rounded-xl p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-4">
          Child Attendance
        </h2>

        <div className="space-y-3">
          <div className="flex justify-between">
            <span>January</span>
            <span>95%</span>
          </div>

          <div className="flex justify-between">
            <span>February</span>
            <span>92%</span>
          </div>

          <div className="flex justify-between">
            <span>March</span>
            <span>96%</span>
          </div>
        </div>
      </div>

      {/* Notices */}
      <div className="bg-white shadow-lg rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">
          Notices
        </h2>

        {notices.map((notice) => (
          <div key={notice.id} className="border-b py-4">
            <h3 className="font-semibold">
              {notice.title}
            </h3>

            <p>{notice.description}</p>
          </div>
        ))}
      </div>

    </div>
  );
}