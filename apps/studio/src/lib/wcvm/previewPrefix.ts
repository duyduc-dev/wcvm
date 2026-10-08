/** The URL segment Studio's previews are served under (`/<segment>/<port>/`). Template projects
 *  read it at runtime to find their router base path, so it lives in one place. */
export const PREVIEW_SEGMENT = "__studio_preview__";
export const PREVIEW_PATH_PREFIX = `/${PREVIEW_SEGMENT}/`;
