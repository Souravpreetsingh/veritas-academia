// AUTO-GENERATED — do not edit by hand.
export type Persona = "instructor" | "student" | "public";
export type ScreenDef = {
  id: string;
  persona: Persona;
  slug: string;
  route: string;
  label: string;
  group: string;
  title: string;
  mainClassName: string;
};
export const SCREENS: ScreenDef[] = [
  {
    "id": "public-home",
    "persona": "public",
    "slug": "home",
    "route": "/",
    "label": "Veritas Academia",
    "group": "",
    "title": "Veritas Academia — Public Website Homepage",
    "mainClassName": "bg-[#090a10] text-slate-100 font-sans antialiased selection:bg-brand-magenta selection:text-white relative overflow-x-hidden min-h-screen"
  },
  {
    "id": "instructor-overview",
    "persona": "instructor",
    "slug": "overview",
    "route": "/instructor",
    "label": "Overview",
    "group": "overview",
    "title": "Overview",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-assignment-workspace",
    "persona": "instructor",
    "slug": "assignment-workspace-fbx-104621",
    "route": "/instructor/assignments/FBX-104621",
    "label": "Assignment Workspace",
    "group": "my-work",
    "title": "Assignment Workspace",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-availability",
    "persona": "instructor",
    "slug": "availability",
    "route": "/instructor/availability",
    "label": "Availability",
    "group": "availability",
    "title": "Availability",
    "mainClassName": "relative pt-16 bg-background min-h-screen w-full px-8"
  },
  {
    "id": "instructor-deliverables",
    "persona": "instructor",
    "slug": "deliverables",
    "route": "/instructor/deliverables",
    "label": "Deliverables",
    "group": "my-work",
    "title": "Deliverables",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-earnings",
    "persona": "instructor",
    "slug": "earnings",
    "route": "/instructor/earnings",
    "label": "Earnings & Payout",
    "group": "earnings",
    "title": "Earnings & Payout",
    "mainClassName": "relative pt-16 bg-surface min-h-screen w-full px-8"
  },
  {
    "id": "instructor-incoming-requests",
    "persona": "instructor",
    "slug": "incoming-requests",
    "route": "/instructor/incoming-requests",
    "label": "Incoming Requests",
    "group": "incoming-requests",
    "title": "Incoming Requests",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-my-work",
    "persona": "instructor",
    "slug": "my-work",
    "route": "/instructor/my-work",
    "label": "My Work",
    "group": "my-work",
    "title": "My Work",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-request-details",
    "persona": "instructor",
    "slug": "request-details-fbx-104621",
    "route": "/instructor/requests/FBX-104621",
    "label": "Request FBX-104621",
    "group": "incoming-requests",
    "title": "Request FBX-104621",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "instructor-revisions",
    "persona": "instructor",
    "slug": "revisions",
    "route": "/instructor/revisions",
    "label": "Revisions & Resubmission",
    "group": "my-work",
    "title": "Revisions & Resubmission",
    "mainClassName": "w-full pt-16 bg-background min-h-screen px-8 py-6"
  },
  {
    "id": "student-dashboard",
    "persona": "student",
    "slug": "dashboard",
    "route": "/student",
    "label": "Dashboard",
    "group": "dashboard",
    "title": "Dashboard",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-documents",
    "persona": "student",
    "slug": "documents",
    "route": "/student/documents",
    "label": "Documents",
    "group": "documents",
    "title": "Documents",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-document-upload",
    "persona": "student",
    "slug": "document-upload",
    "route": "/student/documents/upload",
    "label": "Document Upload",
    "group": "documents",
    "title": "Document Upload",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-faculty-profile",
    "persona": "student",
    "slug": "faculty-profile-marcus-vance",
    "route": "/student/faculty/marcus-vance",
    "label": "Dr. Marcus Vance",
    "group": "find-faculty-instructors",
    "title": "Dr. Marcus Vance",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-find-faculty",
    "persona": "student",
    "slug": "find-faculty",
    "route": "/student/find-faculty",
    "label": "Find Faculty & Instructors",
    "group": "find-faculty-instructors",
    "title": "Find Faculty & Instructors",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-help",
    "persona": "student",
    "slug": "help",
    "route": "/student/help",
    "label": "Help & Support",
    "group": "",
    "title": "Help & Support",
    "mainClassName": "relative pt-16 bg-background min-h-screen"
  },
  {
    "id": "student-messages",
    "persona": "student",
    "slug": "messages",
    "route": "/student/messages",
    "label": "Messages",
    "group": "messages",
    "title": "Messages",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-my-requests",
    "persona": "student",
    "slug": "my-requests",
    "route": "/student/my-requests",
    "label": "My Requests",
    "group": "my-requests",
    "title": "My Requests",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-new-request",
    "persona": "student",
    "slug": "new-service-request",
    "route": "/student/new-service-request",
    "label": "New Service Request",
    "group": "new-service-request",
    "title": "New Service Request",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-notifications",
    "persona": "student",
    "slug": "notifications",
    "route": "/student/notifications",
    "label": "Notifications",
    "group": "",
    "title": "Notifications",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-request-details",
    "persona": "student",
    "slug": "request-details-fbx-104582",
    "route": "/student/requests/FBX-104582",
    "label": "Request FBX-104582",
    "group": "my-requests",
    "title": "Request FBX-104582",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-review-submit",
    "persona": "student",
    "slug": "review-submit",
    "route": "/student/review-submit",
    "label": "Review & Submit",
    "group": "new-service-request",
    "title": "Review & Submit",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-revisions",
    "persona": "student",
    "slug": "revisions",
    "route": "/student/revisions",
    "label": "Revision Tracking",
    "group": "my-submissions",
    "title": "Revision Tracking",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-settings",
    "persona": "student",
    "slug": "settings",
    "route": "/student/settings",
    "label": "Settings",
    "group": "settings",
    "title": "Settings",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  },
  {
    "id": "student-submission-review",
    "persona": "student",
    "slug": "submission-review",
    "route": "/student/submissions",
    "label": "Submission Review & Feedback",
    "group": "my-submissions",
    "title": "Submission Review & Feedback",
    "mainClassName": "relative pt-16 bg-background min-h-screen px-8 py-6 w-full"
  }
];
export const byId = (id: string) => SCREENS.find((s) => s.id === id)!;
export const byRoute = (route: string) => SCREENS.find((s) => s.route === route);
