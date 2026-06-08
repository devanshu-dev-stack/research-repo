# Flow Taxonomy — Collage AI (derived from FigJam export)

This replaces the placeholder e-commerce stages (Onboarding/Checkout/etc.) from blueprint v1.
**Collage AI is an education/teaching platform.** The taxonomy below is read directly from your
flow and is what the classifier should tag feedback against.

The taxonomy has two top-level **personas** (Student, Faculty). Feedback is tagged with one or
more **stages**; stages are nested. `seed_for_classifier` is the description text that gets
embedded to drive semantic matching (§5 of ARCHITECTURE.md).

---

## Persona: STUDENT

| Stage | Parent | seed_for_classifier (embedded) |
|---|---|---|
| Auth — Log In | — | Student signing in to Collage AI to reach a course. |
| Auth — Sign Up | — | Student creating an account; students cannot create courses. |
| Course Home | — | Landing course view a student enters after auth. |
| Student Dashboard | Course Home | Student's overview of courses, progress, and what to do next. |
| Lessons | Course Home | Browsing and opening lessons within a course. |
| Lessons → Pages | Lessons | Static page content inside a lesson. |
| Lessons → Sources | Lessons | Reference materials / sources attached to a lesson. |
| Lessons → Lesson Content | Lessons | Reading lesson content; surfaces the Learning Objective. |
| Lessons → Lesson Exercise | Lessons | Interactive exercise; student selects an action. |
| Lessons → AI Chatbot (help) | Lesson Exercise | In-exercise AI tutor a student invokes for help (repeatable). |
| Summatives | Course Home | Student's graded assessments area. |
| Summatives → Open Assessment | Summatives | Disclaimer → open assessment → confirmation → completion → view results. |
| Summatives → Supervised Assessment | Summatives | Proctored/supervised assessment flow with its own disclaimer. |
| Summatives → Completed Summatives | Summatives | Viewing already-completed assessments. |

## Persona: FACULTY

| Stage | Parent | seed_for_classifier (embedded) |
|---|---|---|
| Course Setup | — | Faculty creating a course: New Course → New Course Added. |
| Faculty Dashboard | Course Setup | Faculty overview of their course(s). |
| Authoring — Lessons | Course Setup | Building lessons by uploading material or writing text. |
| Lessons → Objectives | Authoring — Lessons | Generated / manual / add-generated learning objectives. |
| Lessons → Concepts | Objectives | Generated / manual / add-generated concepts; conflict resolution. |
| Lessons → Lesson Concept blocks | Concepts | Add/Insert/Generate/New concept content blocks. |
| Lessons → Lesson Exercise blocks | Concepts | Add/Insert/Generate/New exercise blocks; tool tips; error screen. |
| Lessons → Preview & Publish | Authoring — Lessons | Preview lesson → settings → publish / unpublish / update. |
| Authoring — Summatives | Course Setup | Building summatives by upload/write/from existing lesson. |
| Summatives → Objectives | Authoring — Summatives | Generated / manual objectives for an assessment. |
| Summatives → Questions | Summatives Objectives | Generated questions and question groups. |
| Summatives → Question blocks | Questions | Add/Select/Prompt question blocks; instructions; calibration. |
| Summatives → Preview & Publish | Authoring — Summatives | Preview → publish summative → confirmation → unpublish/update. |
| Analytics — Overview | Course Setup | Faculty analytics overview across the course. |
| Analytics — Insight | Course Setup | Drill-down analytic insights. |
| AI Tutor (faculty) | Course Setup | Faculty-side AI tutor configuration/use. |
| Library | Course Setup | Material library; add new material. |
| Invite — Email | Course Setup | Inviting students/faculty by email. |
| Invite — Link | Course Setup | Inviting via shareable link. |

---

## Seeding it

Feed this file straight into `flow.importFromFigjam` (or the manual seed path): each row becomes a
`flow_stages` row, `parent` resolves the `parent_id`, and `seed_for_classifier` is embedded into
`flow_stages.embedding`. Persona is stored on the top-level node and inherited.

When you next re-export FigJam to JSON/CSV, the `source_ref` column lets us match these existing
stages to FigJam node IDs so re-syncing updates descriptions instead of duplicating stages.

> Note: I corrected the blueprint's example stages to match this. The schema, pipeline, and
> classifier design are unchanged — only the seed taxonomy differs, which is exactly the
> swap-in point the design anticipated.
