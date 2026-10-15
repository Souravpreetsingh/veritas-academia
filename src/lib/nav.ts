export type NavBadge = { text: string; tone: "primary" | "secondary" | "outline" };

export type NavItem = {
  path: string; // data-path from the design system
  label: string;
  icon: string;
  route: string;
  badge?: NavBadge;
};

export type NavSection = {
  heading?: string;
  items: NavItem[];
};

export const INSTRUCTOR_NAV: NavSection[] = [
  {
    heading: "Core Workspace",
    items: [
      { path: "overview", label: "Overview", icon: "grid_view", route: "/instructor" },
      {
        path: "incoming-requests",
        label: "Incoming Requests",
        icon: "inbox",
        route: "/instructor/incoming-requests",
        badge: { text: "3", tone: "primary" },
      },
      {
        path: "my-work",
        label: "My Work",
        icon: "assignment",
        route: "/instructor/my-work",
        badge: { text: "5", tone: "outline" },
      },
      {
        path: "messages",
        label: "Messages",
        icon: "chat_bubble",
        route: "/instructor/messages",
        badge: { text: "1 unread", tone: "secondary" },
      },
      { path: "students", label: "Students", icon: "school", route: "/instructor/students" },
      { path: "documents", label: "Documents", icon: "description", route: "/instructor/documents" },
    ],
  },
  {
    heading: "Management & Finance",
    items: [
      { path: "earnings", label: "Earnings", icon: "payments", route: "/instructor/earnings" },
      { path: "availability", label: "Availability", icon: "event_available", route: "/instructor/availability" },
      { path: "profile", label: "Profile", icon: "account_circle", route: "/instructor/profile" },
      { path: "settings", label: "Settings", icon: "tune", route: "/instructor/settings" },
    ],
  },
];

export const STUDENT_NAV: NavSection[] = [
  {
    heading: "Core",
    items: [
      { path: "dashboard", label: "Dashboard", icon: "dashboard", route: "/student" },
      {
        path: "find-faculty-instructors",
        label: "Find Faculty & Instructors",
        icon: "school",
        route: "/student/find-faculty",
      },
      {
        path: "new-service-request",
        label: "New Service Request",
        icon: "note_add",
        route: "/student/new-service-request",
      },
      { path: "my-requests", label: "My Requests", icon: "receipt_long", route: "/student/my-requests" },
      { path: "messages", label: "Messages", icon: "chat_bubble", route: "/student/messages" },
      { path: "documents", label: "Documents", icon: "description", route: "/student/documents" },
      { path: "manuscript-audits", label: "Manuscript Audits", icon: "find_in_page", route: "/student/manuscript-audits" },
    ],
  },
  {
    heading: "Academic Vault",
    items: [
      { path: "my-documents", label: "My Documents", icon: "folder", route: "/student/my-documents" },
      { path: "my-submissions", label: "My Submissions", icon: "inventory_2", route: "/student/submissions" },
      {
        path: "originality-reports",
        label: "Originality Reports",
        icon: "verified",
        route: "/student/originality-reports",
      },
      {
        path: "citations-integrity",
        label: "Citations & Integrity",
        icon: "fact_check",
        route: "/student/citations-integrity",
      },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { path: "consultations", label: "Consultations", icon: "forum", route: "/student/consultations" },
      { path: "faculty-feedback", label: "Faculty Feedback", icon: "rate_review", route: "/student/faculty-feedback" },
      { path: "settings", label: "Settings", icon: "tune", route: "/student/settings" },
    ],
  },
];

export const navFor = (persona: "instructor" | "student") =>
  persona === "instructor" ? INSTRUCTOR_NAV : STUDENT_NAV;
