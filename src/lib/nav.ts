// Real, implemented portal navigation.
//
// Every route listed here renders a genuine, database-backed page. Prototype
// destinations (messages, notifications, earnings, availability, …) are
// deliberately absent so the sidebar can never link to mock content.

export type NavItem = {
  /** Matches the `group` prop a page passes to Shell, for active-state. */
  path: string;
  label: string;
  icon: string;
  route: string;
};

export type NavSection = {
  heading?: string;
  items: NavItem[];
};

export const STUDENT_NAV: NavSection[] = [
  {
    heading: "Workspace",
    items: [
      { path: "dashboard", label: "Dashboard", icon: "grid_view", route: "/student" },
      {
        path: "my-requests",
        label: "My Requests",
        icon: "receipt_long",
        route: "/student/my-requests",
      },
      {
        path: "new-service-request",
        label: "New Request",
        icon: "add_circle",
        route: "/student/new-service-request",
      },
      {
        path: "find-faculty",
        label: "Find Instructors",
        icon: "school",
        route: "/student/find-faculty",
      },
      {
        path: "documents",
        label: "Documents",
        icon: "description",
        route: "/student/documents",
      },
    ],
  },
  {
    heading: "Account",
    items: [
      {
        path: "instructor-application",
        label: "Instructor Application",
        icon: "badge",
        route: "/student/instructor-application",
      },
    ],
  },
];

export const INSTRUCTOR_NAV: NavSection[] = [
  {
    heading: "Workspace",
    items: [
      { path: "overview", label: "Overview", icon: "grid_view", route: "/instructor" },
      {
        path: "incoming-requests",
        label: "Incoming Requests",
        icon: "inbox",
        route: "/instructor/incoming-requests",
      },
    ],
  },
];

export const navFor = (persona: "instructor" | "student") =>
  persona === "instructor" ? INSTRUCTOR_NAV : STUDENT_NAV;
