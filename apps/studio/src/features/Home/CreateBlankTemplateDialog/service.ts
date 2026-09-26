export const DEFAULT_PROJECTS_DIR = "/home/user/projects";

// Collapses invalid characters while typing, but doesn't trim edge dashes - doing so on every
// keystroke would delete a trailing "-" the instant it's typed, before the next character (e.g.
// "y" in "my-app") could ever follow it.
export const slugifyLive = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");

export const slugify = (value: string) =>
  slugifyLive(value).replace(/^-|-$/g, "");

export const buildProjectPath = (directory: string, projectName: string) =>
  `${directory.replace(/\/$/, "")}/${projectName}`;
