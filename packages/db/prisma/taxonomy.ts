// Collage AI user-flow taxonomy — mirrors FLOW_TAXONOMY.md (read from the
// real FigJam export). Top-level nodes carry persona; children inherit it.
// `seed` is the description embedded to drive semantic classification.

export type Persona = "student" | "faculty" | "both";

export interface StageSeed {
  name: string;
  slug: string;
  persona: Persona;
  seed: string;
  children?: StageSeed[];
}

export const TAXONOMY: StageSeed[] = [
  // ───────────── STUDENT ─────────────
  {
    name: "Auth — Log In",
    slug: "auth-login",
    persona: "student",
    seed: "Student signing in to Collage AI to reach a course.",
  },
  {
    name: "Auth — Sign Up",
    slug: "auth-signup",
    persona: "student",
    seed: "Student creating an account; students cannot create courses.",
  },
  {
    name: "Course Home",
    slug: "course-home",
    persona: "student",
    seed: "Landing course view a student enters after auth.",
    children: [
      {
        name: "Student Dashboard",
        slug: "student-dashboard",
        persona: "student",
        seed: "Student's overview of courses, progress, and what to do next.",
      },
      {
        name: "Lessons",
        slug: "lessons",
        persona: "student",
        seed: "Browsing and opening lessons within a course.",
        children: [
          { name: "Pages", slug: "lessons-pages", persona: "student", seed: "Static page content inside a lesson." },
          { name: "Sources", slug: "lessons-sources", persona: "student", seed: "Reference materials and sources attached to a lesson." },
          { name: "Lesson Content", slug: "lesson-content", persona: "student", seed: "Reading lesson content; surfaces the learning objective." },
          {
            name: "Lesson Exercise",
            slug: "lesson-exercise",
            persona: "student",
            seed: "Interactive exercise where the student selects an action.",
            children: [
              { name: "AI Chatbot (help)", slug: "lesson-ai-chatbot", persona: "student", seed: "In-exercise AI tutor a student invokes for help, repeatable." },
            ],
          },
        ],
      },
      {
        name: "Summatives",
        slug: "summatives",
        persona: "student",
        seed: "Student's graded assessments area.",
        children: [
          { name: "Open Assessment", slug: "summatives-open", persona: "student", seed: "Disclaimer, open assessment, confirmation, completion, view results." },
          { name: "Supervised Assessment", slug: "summatives-supervised", persona: "student", seed: "Proctored or supervised assessment flow with its own disclaimer." },
          { name: "Completed Summatives", slug: "summatives-completed", persona: "student", seed: "Viewing already-completed assessments." },
        ],
      },
    ],
  },

  // ───────────── FACULTY ─────────────
  {
    name: "Course Setup",
    slug: "course-setup",
    persona: "faculty",
    seed: "Faculty creating a course: New Course then New Course Added.",
    children: [
      { name: "Faculty Dashboard", slug: "faculty-dashboard", persona: "faculty", seed: "Faculty overview of their course(s)." },
      {
        name: "Authoring — Lessons",
        slug: "authoring-lessons",
        persona: "faculty",
        seed: "Building lessons by uploading material or writing text.",
        children: [
          { name: "Lesson Objectives", slug: "lesson-objectives", persona: "faculty", seed: "Generated, manual, or add-generated learning objectives." },
          { name: "Lesson Concepts", slug: "lesson-concepts", persona: "faculty", seed: "Generated, manual, or add-generated concepts; conflict resolution." },
          { name: "Lesson Concept blocks", slug: "lesson-concept-blocks", persona: "faculty", seed: "Add, insert, generate, or new concept content blocks." },
          { name: "Lesson Exercise blocks", slug: "lesson-exercise-blocks", persona: "faculty", seed: "Add, insert, generate, or new exercise blocks; tool tips; error screen." },
          { name: "Lesson Preview & Publish", slug: "lesson-preview-publish", persona: "faculty", seed: "Preview lesson, settings, publish, unpublish, or update." },
        ],
      },
      {
        name: "Authoring — Summatives",
        slug: "authoring-summatives",
        persona: "faculty",
        seed: "Building summatives by upload, write, or from an existing lesson.",
        children: [
          { name: "Summative Objectives", slug: "summative-objectives", persona: "faculty", seed: "Generated or manual objectives for an assessment." },
          { name: "Summative Questions", slug: "summative-questions", persona: "faculty", seed: "Generated questions and question groups." },
          { name: "Question blocks", slug: "question-blocks", persona: "faculty", seed: "Add, select, or prompt question blocks; instructions; calibration." },
          { name: "Summative Preview & Publish", slug: "summative-preview-publish", persona: "faculty", seed: "Preview, publish summative, confirmation, unpublish, or update." },
        ],
      },
      { name: "Analytics — Overview", slug: "analytics-overview", persona: "faculty", seed: "Faculty analytics overview across the course." },
      { name: "Analytics — Insight", slug: "analytics-insight", persona: "faculty", seed: "Drill-down analytic insights." },
      { name: "AI Tutor (faculty)", slug: "ai-tutor-faculty", persona: "faculty", seed: "Faculty-side AI tutor configuration and use." },
      { name: "Library", slug: "library", persona: "faculty", seed: "Material library; add new material." },
      { name: "Invite — Email", slug: "invite-email", persona: "faculty", seed: "Inviting students or faculty by email." },
      { name: "Invite — Link", slug: "invite-link", persona: "faculty", seed: "Inviting via a shareable link." },
    ],
  },
];
