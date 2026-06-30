import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  BookOpen,
  Cpu,
  Palette,
  LineChart,
  FlaskConical,
  Globe2,
  CheckCircle2,
  ArrowRight,
  GraduationCap,
} from "lucide-react";

/*MOTION CONFIG  — single source of truth for all timing/easing */
const MOTION = {
  ease: [0.22, 1, 0.36, 1],
  duration: {
    fast: 0.35,
    normal: 0.6,
    slow: 0.9,
  },
  stagger: {
    sm: 0.12,
    md: 0.18,
  },
};

/*ANIMATION VARIANTS  — centralised, no inline durations */
const makeVariants = (shouldReduceMotion) => ({
  fadeUp: {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 40 },
    visible: (delay = 0) => ({
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0 : MOTION.duration.normal,
        ease: MOTION.ease,
        delay,
      },
    }),
  },

  slideLeft: {
    hidden: { opacity: 0, x: shouldReduceMotion ? 0 : -28 },
    visible: (delay = 0) => ({
      opacity: 1,
      x: 0,
      transition: {
        duration: shouldReduceMotion ? 0 : MOTION.duration.normal,
        ease: MOTION.ease,
        delay,
      },
    }),
  },

  scaleIn: {
    hidden: { opacity: 0, scale: shouldReduceMotion ? 1 : 0.9 },
    visible: (delay = 0) => ({
      opacity: 1,
      scale: 1,
      transition: {
        duration: shouldReduceMotion ? 0 : MOTION.duration.fast,
        ease: MOTION.ease,
        delay,
      },
    }),
  },

  staggerContainer: (stagger = MOTION.stagger.md) => ({
    hidden: {},
    visible: { transition: { staggerChildren: shouldReduceMotion ? 0 : stagger } },
  }),
});

/*useCountUp  — with RAF cleanup to prevent memory leaks*/
function useCountUp(target, duration = 1600, start = false) {
  const [count, setCount] = React.useState(0);

  useEffect(() => {
    if (!start) return;

    let rafId = null;
    let startTime = null;

    const step = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      setCount(Math.floor(progress * target));
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);

    // Cleanup: cancel the pending frame on unmount or re-run
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [start, target, duration]);

  return count;
}

/*StatCard  — memoised to avoid re-renders from parent updates */
const StatCard = React.memo(function StatCard({ value, label, delay, variants }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const numeric = parseInt(value, 10);
  const suffix = value.replace(String(numeric), "");
  const count = useCountUp(numeric, 1600, inView);

  return (
    <motion.div
      ref={ref}
      custom={delay}
      variants={variants.scaleIn}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true }}
      className="text-center px-6"
    >
      <div className="text-3xl font-bold text-blue-600">
        {count}
        {suffix}
      </div>
      <div className="text-sm text-slate-500 font-medium mt-1">{label}</div>
    </motion.div>
  );
});

/*STATIC DATA  — defined outside component to avoid re-creation */
const DEPARTMENTS = [
  {
    title: "STEM & Innovation",
    icon: <Cpu className="w-8 h-8" aria-hidden="true" />,
    description:
      "Rigorous training in robotics, advanced mathematics, and computational thinking.",
    subjects: ["Quantum Physics", "AI & Robotics", "Calculus BC", "Organic Chemistry"],
  },
  {
    title: "Digital Arts & Design",
    icon: <Palette className="w-8 h-8" aria-hidden="true" />,
    description:
      "Bridging the gap between classical aesthetics and modern digital production.",
    subjects: ["3D Modeling", "UX/UI Design", "Art History", "Digital Cinematography"],
  },
  {
    title: "Economics & Global Trade",
    icon: <LineChart className="w-8 h-8" aria-hidden="true" />,
    description:
      "Preparing future leaders for the complexities of global markets and entrepreneurship.",
    subjects: ["Macroeconomics", "Game Theory", "Business Ethics", "Market Analysis"],
  },
  {
    title: "Humanities & Law",
    icon: <Globe2 className="w-8 h-8" aria-hidden="true" />,
    description:
      "Critical analysis of social structures, literature, and international legal frameworks.",
    subjects: ["World Philosophy", "Constitutional Law", "Linguistics", "Political Science"],
  },
];

const PHILOSOPHY_ITEMS = [
  {
    title: "Experiential Learning",
    desc: "We believe in 'learning by doing' through lab work, field trips, and real-world projects.",
    icon: <FlaskConical className="text-blue-600" aria-hidden="true" />,
  },
  {
    title: "Global Perspective",
    desc: "Our curriculum is mapped to international standards, preparing students for a global career.",
    icon: <Globe2 className="text-blue-600" aria-hidden="true" />,
  },
  {
    title: "Individual Mentorship",
    desc: "Small class sizes allow for personalized academic paths tailored to each student's strengths.",
    icon: <GraduationCap className="text-blue-600" aria-hidden="true" />,
  },
];

const FACILITIES = [
  {
    title: "Smart Research Labs",
    detail: "Equipped with the latest IoT and AI hardware.",
  },
  {
    title: "The Great Library",
    detail: "Access to 50,000+ digital journals and physical rare editions.",
  },
  {
    title: "Collaborative Hubs",
    detail: "Open-plan spaces designed for group innovation and debates.",
  },
];

const CTA_LINKS = [
  { to: "/gallery", label: "Explore Our Campus" },
  { to: "/prospectus", label: "Download Prospectus" },
];

/*MAIN COMPONENT*/
const Academics = () => {
  const shouldReduceMotion = useReducedMotion();

  // Build all variants once, keyed on reduced-motion preference
  const v = useMemo(
    () => makeVariants(shouldReduceMotion),
    [shouldReduceMotion]
  );

  // Hover props: disabled when user prefers reduced motion
  const hoverLift = shouldReduceMotion
    ? {}
    : { whileHover: { y: -8, transition: { duration: MOTION.duration.fast } } };

  const hoverIconBounce = shouldReduceMotion
    ? {}
    : { whileHover: { rotate: 8, scale: 1.1 }, transition: { type: "spring", stiffness: 300 } };

  return (
    <div className="bg-[var(--card-bg)]">

      {/* ── Hero  */}
      <div className="bg-slate-900 py-28 px-4 text-center relative overflow-hidden">
        {/* Ambient orb — purely decorative, respects reduced motion */}
        {!shouldReduceMotion && (
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
          >
            <motion.div
              className="absolute top-[-120px] left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full"
              style={{
                background:
                  "radial-gradient(ellipse at center, rgba(59,130,246,0.18) 0%, transparent 70%)",
              }}
              animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
              transition={{
                duration: 6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          </div>
        )}

        <motion.div
          className="relative z-10"
          initial="hidden"
          animate="visible"
          variants={v.staggerContainer(MOTION.stagger.md)}
        >
          <motion.span
            variants={v.fadeUp}
            className="text-blue-400 font-bold tracking-widest uppercase text-sm"
          >
            Academic Excellence
          </motion.span>
          <motion.h1
            variants={v.fadeUp}
            className="text-4xl md:text-6xl font-bold text-white mt-4 mb-6"
          >
            Our Academic Programs
          </motion.h1>
          <motion.p
            variants={v.fadeUp}
            className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed"
          >
            EduStream Academy offers a world-class curriculum designed to foster
            intellectual curiosity and prepare students for the world's most
            prestigious universities.
          </motion.p>
        </motion.div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">

        {/* ── Learning Philosophy  */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-32"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          variants={v.staggerContainer(MOTION.stagger.md)}
        >
          {PHILOSOPHY_ITEMS.map((item, i) => (
            <motion.div
              key={item.title}
              className="text-center group"
              variants={v.fadeUp}
              {...hoverLift}
            >
              {/* Icon: only scale on hover (single effect) */}
              <motion.div
                className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6
                           group-hover:bg-blue-600 transition-colors duration-300"
                whileHover={shouldReduceMotion ? {} : { scale: 1.1 }}
                transition={{ duration: MOTION.duration.fast }}
              >
                <span className="group-hover:[&>svg]:text-white transition-colors duration-300">
                  {item.icon}
                </span>
              </motion.div>
              <h3 className="text-xl font-bold text-[var(--text-primary)] mb-3">
                {item.title}
              </h3>
              <p className="text-slate-600 leading-relaxed">{item.desc}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* ── Departments Grid ── */}
        <div className="mb-32">
          <motion.h2
            className="text-3xl font-bold text-[var(--text-primary)] mb-12 text-center"
            custom={0}
            variants={v.fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            Academic Departments
          </motion.h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {DEPARTMENTS.map((dept, i) => (
              <motion.div
                key={dept.title}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-40px" }}
                variants={v.fadeUp}
                custom={i * MOTION.stagger.sm}
                whileHover={
                  shouldReduceMotion
                    ? {}
                    : { y: -10, scale: 1.02, transition: { duration: MOTION.duration.fast } }
                }
                className="group bg-[var(--card-bg)] p-6 sm:p-10 rounded-3xl border border-slate-100
                           shadow-sm hover:shadow-2xl hover:border-blue-200 transition-shadow duration-500"
              >
                <div className="flex justify-between items-start mb-8">
                  {/* Icon: single hover effect — scale only (no conflicting CSS transition on transform) */}
                  <motion.div
                    {...hoverIconBounce}
                    className="p-4 bg-[var(--bg-secondary)] rounded-2xl text-blue-600
                               group-hover:bg-blue-600 group-hover:text-white transition-colors duration-300"
                  >
                    {dept.icon}
                  </motion.div>
                  <span className="text-slate-300 font-mono text-xl" aria-hidden="true">
                    0{i + 1}
                  </span>
                </div>

                <h3 className="text-2xl font-bold text-[var(--text-primary)] mb-4">
                  {dept.title}
                </h3>
                <p className="text-slate-600 mb-8 leading-relaxed">
                  {dept.description}
                </p>

                <div className="border-t border-slate-100 pt-8">
                  <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">
                    Core Subjects
                  </p>
                  {/* Subject pills: fade-in only on scroll, no hover animation (reduced noise) */}
                  <div className="flex flex-wrap gap-2" role="list" aria-label={`${dept.title} subjects`}>
                    {dept.subjects.map((sub, j) => (
                      <motion.span
                        key={sub}
                        role="listitem"
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{
                          delay: shouldReduceMotion ? 0 : i * 0.08 + j * 0.06,
                          duration: MOTION.duration.fast,
                        }}
                        className="px-4 py-2 bg-[var(--bg-secondary)] text-slate-700
                                   rounded-full text-sm font-medium border border-slate-100"
                      >
                        {sub}
                      </motion.span>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* ── Facilities Section  */}
        <motion.div
          className="bg-slate-900 rounded-2xl sm:rounded-[3rem] overflow-hidden"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          variants={v.fadeUp}
          custom={0}
        >
          <div className="flex flex-col lg:flex-row">
            <div className="p-6 sm:p-12 lg:p-20 lg:w-1/2">
              <motion.h2
                className="text-3xl font-bold text-white mb-8"
                custom={0.1}
                variants={v.fadeUp}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
              >
                World-Class Learning Infrastructure
              </motion.h2>

              <div className="space-y-6">
                {FACILITIES.map((f, i) => (
                  <motion.div
                    key={f.title}
                    className="flex gap-4"
                    custom={i * MOTION.stagger.sm}
                    variants={v.slideLeft}
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true }}
                  >
                    <CheckCircle2
                      className="text-blue-500 mt-1 flex-shrink-0"
                      aria-hidden="true"
                    />
                    <div>
                      <h4 className="text-white font-bold">{f.title}</h4>
                      <p className="text-slate-400 text-sm">{f.detail}</p>
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="mt-12 flex flex-col gap-4">
                {CTA_LINKS.map((link, i) => (
                  <motion.div
                    key={link.to}
                    custom={0.4 + i * MOTION.stagger.sm}
                    variants={v.slideLeft}
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true }}
                    whileHover={shouldReduceMotion ? {} : { x: 5 }}
                  >
                    <Link
                      to={link.to}
                      className="flex items-center gap-2 text-blue-400 font-bold
                                 hover:text-blue-300 transition-colors focus-visible:outline-none
                                 focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
                    >
                      {link.label}
                      {/* Arrow: animate only when motion is allowed */}
                      {shouldReduceMotion ? (
                        <ArrowRight size={20} aria-hidden="true" />
                      ) : (
                        <motion.span
                          className="inline-block"
                          aria-hidden="true"
                          animate={{ x: [0, 4, 0] }}
                          transition={{
                            duration: 1.4,
                            repeat: Infinity,
                            ease: "easeInOut",
                            delay: i * 0.3,
                          }}
                        >
                          <ArrowRight size={20} />
                        </motion.span>
                      )}
                    </Link>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Image: scale-in on scroll, no CSS transform conflict */}
            <motion.div
              className="lg:w-1/2 h-[400px] lg:h-auto overflow-hidden"
              initial={{ opacity: 0, scale: shouldReduceMotion ? 1 : 1.06 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{
                duration: shouldReduceMotion ? 0 : MOTION.duration.slow,
                ease: MOTION.ease,
              }}
            >
              <img
                src="https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=1200"
                className="w-full h-full object-cover"
                alt="Aerial view of a modern school campus with glass buildings and open courtyards"
                loading="lazy"
              />
            </motion.div>
          </div>
        </motion.div>

        {/* ── Academic Outcome ── */}
        <motion.div
          className="mt-32 text-center bg-blue-50 p-6 sm:p-12 rounded-3xl border border-blue-100"
          custom={0}
          variants={v.fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
        >
          <motion.div
            initial={shouldReduceMotion ? {} : { scale: 0, rotate: -15 }}
            whileInView={shouldReduceMotion ? {} : { scale: 1, rotate: 0 }}
            viewport={{ once: true }}
            transition={{ type: "spring", stiffness: 220, damping: 14, delay: 0.1 }}
            aria-hidden="true"
          >
            <BookOpen className="mx-auto text-blue-600 mb-6" size={48} />
          </motion.div>

          <motion.h2
            className="text-3xl font-bold text-[var(--text-primary)] mb-4"
            custom={0.15}
            variants={v.fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            Academic Excellence Guaranteed
          </motion.h2>

          <motion.p
            className="text-slate-600 max-w-2xl mx-auto mb-8"
            custom={0.25}
            variants={v.fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            Our graduates are currently studying at Ivy League universities and
            leading institutions worldwide. We don't just teach for exams; we
            teach for life.
          </motion.p>

          <div
            className="flex justify-center gap-4 sm:gap-8 items-center"
            aria-label="Key statistics"
          >
            <StatCard
              value="100%"
              label="University Placement"
              delay={0.3}
              variants={v}
            />
            <motion.div
              className="w-px h-12 bg-blue-200"
              aria-hidden="true"
              initial={{ scaleY: 0 }}
              whileInView={{ scaleY: 1 }}
              viewport={{ once: true }}
              transition={{
                duration: shouldReduceMotion ? 0 : MOTION.duration.fast,
                delay: 0.5,
              }}
              style={{ originY: 0 }}
            />
            <StatCard
              value="92%"
              label="Distinction Rate"
              delay={0.4}
              variants={v}
            />
          </div>
        </motion.div>

      </div>
    </div>
  );
};

export default Academics;
