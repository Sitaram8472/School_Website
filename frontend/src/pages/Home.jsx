import React from 'react';
import Hero from '../components/Hero';
import Card from '../components/Card';
import { notices } from '../data/Notices';
import { teachers } from '../data/Teacher';

const Home = () => {
  return (
    <div className="animate-in fade-in duration-700">
      <Hero />

      {/* Statistics Section */}
      <section className="bg-blue-600 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold text-white mb-1">1500+</div>
              <div className="text-blue-100 text-sm font-medium">Students</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-white mb-1">85+</div>
              <div className="text-blue-100 text-sm font-medium">Expert Faculty</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-white mb-1">24</div>
              <div className="text-blue-100 text-sm font-medium">Modern Labs</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-white mb-1">98%</div>
              <div className="text-blue-100 text-sm font-medium">Graduation Rate</div>
            </div>
          </div>
        </div>
      </section>

      {/* Latest Notices */}
      <section className="py-20 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-end mb-12">
            <div>
              <h2 className="text-3xl font-bold text-slate-900 mb-2">Notice Board</h2>
              <p className="text-slate-600">Keep up to date with the latest campus news and announcements.</p>
            </div>
            <button className="text-blue-600 font-semibold hover:text-blue-700">View All Notices &rarr;</button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {notices.map((notice) => (
              <Card
                key={notice.id}
                title={notice.title}
                badge={notice.category}
                content={notice.content}
                footer={`Posted on ${new Date(notice.date).toLocaleDateString()}`}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Featured Faculty */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">Meet Our Faculty</h2>
            <p className="text-slate-600 max-w-2xl mx-auto">Our educators are leaders in their fields, dedicated to mentoring and inspiring the next generation.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {teachers.map((teacher) => (
              <Card
                key={teacher.id}
                variant="teacher"
                title={teacher.name}
                subtitle={teacher.role}
                content={teacher.bio}
                image={teacher.image}
                badge={teacher.department}
              />
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-slate-900">
        <div className="max-w-4xl mx-auto text-center px-4">
          <h2 className="text-3xl font-bold text-white mb-6">Ready to start your journey with us?</h2>
          <p className="text-slate-400 text-lg mb-10">
            Admissions are currently open for the **Fall 2026** semester. Contact our admissions office or apply online today.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button className="bg-blue-600 text-white px-8 py-4 rounded-lg font-bold hover:bg-blue-700 transition-all active:scale-95">
              Apply Online
            </button>
            <button className="bg-white text-slate-900 px-8 py-4 rounded-lg font-bold hover:bg-slate-100 transition-all active:scale-95">
              Schedule a Visit
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;