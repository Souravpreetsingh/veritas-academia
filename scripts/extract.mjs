// Extracts the <main> content + inline page <script> from each Stitch screen
// (screens-src/**/code.html) and emits typed modules under src/screens/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outContentDir = path.join(root, "src", "screens", "content");
const outScriptDir = path.join(root, "src", "screens", "scripts");

// folder-name matcher -> screen definition
const SCREENS = [
  // ---- Instructor portal ----
  {
    match: "instructor_dashboard_work_management_overview",
    id: "instructor-overview",
    persona: "instructor",
    slug: "overview",
    route: "/instructor",
    label: "Overview",
    group: "overview",
  },
  {
    match: "instructor_incoming_requests_request_review_workspace",
    id: "instructor-incoming-requests",
    persona: "instructor",
    slug: "incoming-requests",
    route: "/instructor/incoming-requests",
    label: "Incoming Requests",
    group: "incoming-requests",
  },
  {
    match: "instructor_my_work_dashboard_active_assignments_delivery_management",
    id: "instructor-my-work",
    persona: "instructor",
    slug: "my-work",
    route: "/instructor/my-work",
    label: "My Work",
    group: "my-work",
  },
  {
    match: "instructor_request_details_acceptance_workflow_fbx_104621",
    id: "instructor-request-details",
    persona: "instructor",
    slug: "request-details-fbx-104621",
    route: "/instructor/requests/FBX-104621",
    label: "Request FBX-104621",
    group: "incoming-requests",
  },
  {
    match: "instructor_assignment_workspace_requirements_documents_progress_deliverables",
    id: "instructor-assignment-workspace",
    persona: "instructor",
    slug: "assignment-workspace-fbx-104621",
    route: "/instructor/assignments/FBX-104621",
    label: "Assignment Workspace",
    group: "my-work",
  },
  {
    match: "instructor_revisions_resubmission_workspace_revision_requests_change_tracking",
    id: "instructor-revisions",
    persona: "instructor",
    slug: "revisions",
    route: "/instructor/revisions",
    label: "Revisions & Resubmission",
    group: "my-work",
  },
  {
    match: "instructor_deliverables_submission_review_final_quality_check_secure_submission",
    id: "instructor-deliverables",
    persona: "instructor",
    slug: "deliverables",
    route: "/instructor/deliverables",
    label: "Deliverables",
    group: "my-work",
  },
  {
    match: "instructor_earnings_payout_dashboard_available_balance_escrow_tracking",
    id: "instructor-earnings",
    persona: "instructor",
    slug: "earnings",
    route: "/instructor/earnings",
    label: "Earnings & Payout",
    group: "earnings",
  },
  {
    match: "instructor_availability_working_schedule_regular_hours_calendar_sync_request",
    id: "instructor-availability",
    persona: "instructor",
    slug: "availability",
    route: "/instructor/availability",
    label: "Availability",
    group: "availability",
  },
  {
    match: "instructor_profile_dr._marcus_vance",
    id: "student-faculty-profile",
    persona: "student",
    slug: "faculty-profile-marcus-vance",
    route: "/student/faculty/marcus-vance",
    label: "Dr. Marcus Vance",
    group: "find-faculty",
  },
  {
    match: "instructor_directory_find_your_instructor",
    id: "student-find-faculty",
    persona: "student",
    slug: "find-faculty",
    route: "/student/find-faculty",
    label: "Find Faculty & Instructors",
    group: "find-faculty",
  },

  // ---- Student portal ----
  {
    match: "student_dashboard_find_your_instructor",
    id: "student-dashboard",
    persona: "student",
    slug: "dashboard",
    route: "/student",
    label: "Dashboard",
    group: "dashboard",
  },
  {
    match: "my_requests_dashboard_academic_audits",
    id: "student-my-requests",
    persona: "student",
    slug: "my-requests",
    route: "/student/my-requests",
    label: "My Requests",
    group: "manuscript-audits",
  },
  {
    match: "new_service_request_dr._marcus_vance",
    id: "student-new-request",
    persona: "student",
    slug: "new-service-request",
    route: "/student/new-service-request",
    label: "New Service Request",
    group: "new-service-request",
  },
  {
    match: "request_details_progress_timeline_fbx_104582",
    id: "student-request-details",
    persona: "student",
    slug: "request-details-fbx-104582",
    route: "/student/requests/FBX-104582",
    label: "Request FBX-104582",
    group: "manuscript-audits",
  },
  {
    match: "review_submit_request_dr._marcus_vance",
    id: "student-review-submit",
    persona: "student",
    slug: "review-submit",
    route: "/student/review-submit",
    label: "Review & Submit",
    group: "new-service-request",
  },
  {
    match: "document_upload_dr._marcus_vance",
    id: "student-document-upload",
    persona: "student",
    slug: "document-upload",
    route: "/student/documents/upload",
    label: "Document Upload",
    group: "documents",
  },
  {
    match: "student_documents_library_file_management",
    id: "student-documents",
    persona: "student",
    slug: "documents",
    route: "/student/documents",
    label: "Documents",
    group: "documents",
  },
  {
    match: "student_messages_private_instructor_conversation_dr._ananya_sharma",
    id: "student-messages",
    persona: "student",
    slug: "messages",
    route: "/student/messages",
    label: "Messages",
    group: "messages",
  },
  {
    match: "student_notifications_center_activity_inbox",
    id: "student-notifications",
    persona: "student",
    slug: "notifications",
    route: "/student/notifications",
    label: "Notifications",
    group: "notifications",
  },
  {
    match: "student_help_center_support_tickets",
    id: "student-help",
    persona: "student",
    slug: "help",
    route: "/student/help",
    label: "Help & Support",
    group: "help",
  },
  {
    match: "student_settings_account_preferences",
    id: "student-settings",
    persona: "student",
    slug: "settings",
    route: "/student/settings",
    label: "Settings",
    group: "settings",
  },
  {
    match: "student_revision_tracking_version_history_revision_progress_updated_files",
    id: "student-revisions",
    persona: "student",
    slug: "revisions",
    route: "/student/revisions",
    label: "Revision Tracking",
    group: "my-submissions",
  },
  {
    match: "student_submission_review_feedback_deliverables_instructor_feedback_revision",
    id: "student-submission-review",
    persona: "student",
    slug: "submission-review",
    route: "/student/submissions",
    label: "Submission Review & Feedback",
    group: "my-submissions",
  },

  // ---- Public marketing site ----
  {
    match: "veritas_academia_public_website_with_razorpay_payment_integration_pricing",
    id: "public-home",
    persona: "public",
    slug: "home",
    route: "/",
    label: "Veritas Academia",
    group: "home",
  },
];

function findSrcFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSrcFiles(full, acc);
    else if (entry.name === "code.html") acc.push(full);
  }
  return acc;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : "";
}

fs.mkdirSync(outContentDir, { recursive: true });
fs.mkdirSync(outScriptDir, { recursive: true });

const srcRoot = path.join(root, "screens-src");
const files = findSrcFiles(srcRoot);
const manifest = [];

for (const file of files) {
  const folder = path.basename(path.dirname(file));
  const def = SCREENS.find((s) => folder.includes(s.match));
  if (!def) {
    console.warn("!! no mapping for", folder);
    continue;
  }

  const raw = fs.readFileSync(file, "utf8");
  const title = (raw.match(/<title>([^<]*)<\/title>/) || [, def.label])[1];

  const bodyStart = raw.indexOf("<body");
  const bodyOpenEnd = raw.indexOf(">", bodyStart) + 1;
  const bodyOpen = raw.slice(bodyStart, bodyOpenEnd);
  const bodyEnd = raw.lastIndexOf("</body>");
  const body = raw.slice(bodyOpenEnd, bodyEnd);

  const mainIdx = body.indexOf("<main");
  let mainInner = "";
  let mainClassName = "";
  if (mainIdx !== -1) {
    const mainOpenEnd = body.indexOf(">", mainIdx) + 1;
    const mainOpen = body.slice(mainIdx, mainOpenEnd);
    mainClassName = attr(mainOpen, "class");
    const mainClose = body.lastIndexOf("</main>");
    mainInner = body.slice(mainOpenEnd, mainClose);
  } else {
    // bare page (no app shell) — take the whole body, keeping its classes
    mainInner = body;
    mainClassName = attr(bodyOpen, "class");
  }

  // pull every inline <script> out of the content (they run via ScriptRunner)
  let script = "";
  let hit = mainInner.indexOf("<script");
  while (hit !== -1) {
    const sOpenEnd = mainInner.indexOf(">", hit) + 1;
    const sClose = mainInner.indexOf("</script>", sOpenEnd);
    if (sClose === -1) break;
    const body_ = mainInner.slice(sOpenEnd, sClose);
    if (!/type\s*=\s*["']text\/(html|template)/.test(mainInner.slice(hit, sOpenEnd))) {
      script += body_ + "\n;\n";
    }
    mainInner = mainInner.slice(0, hit) + mainInner.slice(sClose + "</script>".length);
    hit = mainInner.indexOf("<script", hit);
  }

  mainInner = mainInner.trim();

  fs.writeFileSync(
    path.join(outContentDir, `${def.id}.ts`),
    `// AUTO-GENERATED from screens-src — do not edit by hand.\n` +
      `const html: string = ${JSON.stringify(mainInner)};\n` +
      `export default html;\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outScriptDir, `${def.id}.ts`),
    `// AUTO-GENERATED from screens-src — do not edit by hand.\n` +
      `const code: string = ${JSON.stringify(script)};\n` +
      `export default code;\n`,
    "utf8",
  );

  manifest.push({
    id: def.id,
    persona: def.persona,
    slug: def.slug,
    route: def.route,
    label: def.label,
    group: def.group,
    title,
    mainClassName,
  });
}

manifest.sort((a, b) => a.route.localeCompare(b.route));

// The sidebar item (data-path) that should read as "active" for each screen.
const GROUP_OVERRIDE = {
  "student-my-requests": "my-requests",
  "student-request-details": "my-requests",
  "student-find-faculty": "find-faculty-instructors",
  "student-faculty-profile": "find-faculty-instructors",
  "student-revisions": "my-submissions",
  "student-submission-review": "my-submissions",
  "student-document-upload": "documents",
  "student-review-submit": "new-service-request",
  "student-notifications": "",
  "student-help": "",
  "public-home": "",
  "instructor-request-details": "incoming-requests",
  "instructor-assignment-workspace": "my-work",
  "instructor-revisions": "my-work",
  "instructor-deliverables": "my-work",
};
for (const m of manifest) {
  if (m.id in GROUP_OVERRIDE) m.group = GROUP_OVERRIDE[m.id];
}

const manifestFile =
  `// AUTO-GENERATED — do not edit by hand.\n` +
  `export type Persona = "instructor" | "student" | "public";\n` +
  `export type ScreenDef = {\n` +
  `  id: string;\n  persona: Persona;\n  slug: string;\n  route: string;\n  label: string;\n  group: string;\n  title: string;\n  mainClassName: string;\n};\n` +
  `export const SCREENS: ScreenDef[] = ${JSON.stringify(manifest, null, 2)};\n` +
  `export const byId = (id: string) => SCREENS.find((s) => s.id === id)!;\n` +
  `export const byRoute = (route: string) => SCREENS.find((s) => s.route === route);\n`;

fs.writeFileSync(path.join(root, "src", "screens", "manifest.ts"), manifestFile, "utf8");

// A static registry so the bundler can resolve screen content by id at build time.
const ids = manifest.map((m) => m.id);
const imports = ids
  .map((id, i) => `import html${i} from "./content/${id}";\nimport js${i} from "./scripts/${id}";`)
  .join("\n");
const contentEntries = ids.map((id, i) => `  ${JSON.stringify(id)}: html${i},`).join("\n");
const scriptEntries = ids.map((id, i) => `  ${JSON.stringify(id)}: js${i},`).join("\n");

const registryFile =
  `// AUTO-GENERATED — do not edit by hand.\n` +
  `${imports}\n` +
  `export const CONTENT: Record<string, string> = {\n${contentEntries}\n};\n` +
  `export const SCRIPTS: Record<string, string> = {\n${scriptEntries}\n};\n` +
  `export const getScreen = (id: string) => CONTENT[id];\n` +
  `export const getScript = (id: string) => SCRIPTS[id] ?? "";\n`;

fs.writeFileSync(path.join(root, "src", "screens", "registry.ts"), registryFile, "utf8");

console.log(`Extracted ${manifest.length} screens.`);
for (const m of manifest) console.log(`  ${m.persona.padEnd(10)} ${m.route}`);
