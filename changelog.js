// ============================================
// 8CM — Site update log
// ------------------------------------------------
// A running, plain-English list of what's changed on the site.
// Newest entry first. This is visible to everyone (no sign-in
// needed) — script.js renders it into the footer.
//
// To add an entry: put a new object at the TOP of this array.
// ============================================
export const changelog = [
  {
    date: "2026-09-12",
    items: [
      "Added a \"Switch student\" option in the profile menu, so you can change who your account is linked to without signing out.",
      "Fixed sign-in re-asking you to pick a student every time — it now remembers your choice properly.",
      "Added this update log to the footer.",
    ],
  },
];
