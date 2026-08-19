import { createOpenNode } from "../../../kernel/vendor/open-node/packages/embed/dist/index.js";
import "../../../kernel/vendor/open-node/packages/ui/src/styles.css";
import { placeholderNodeDefinitions } from "./open-node-placeholders.js";

export function mountOpenNode(container: HTMLElement, project: unknown, theme: "dark" | "light") {
  const themedProject = project && typeof project === "object"
    ? { ...project as Record<string, unknown>, settings: { ...((project as { settings?: Record<string, unknown> }).settings || {}), theme } }
    : project;
  return createOpenNode({
    container,
    project: themedProject as never,
    mode: "embedded-readonly",
    visualOnly: true,
    nodeDefinitions: placeholderNodeDefinitions(themedProject) as never,
    wheelZoomRequiresModifier: true,
    themeTokens: theme === "dark"
      ? { bg: "#111111", panel: "#181818", "panel-2": "#202020", "panel-3": "#292929", text: "#f4f2ed", muted: "#9f9c96", border: "#3d3b38", "border-strong": "#5c5954", accent: "#f4f2ed", "accent-2": "#d6d2ca" }
      : { bg: "#f4f2ed", panel: "#ffffff", "panel-2": "#f3f1ec", "panel-3": "#e8e4dc", text: "#111111", muted: "#77736c", border: "#c8c4bc", "border-strong": "#979188", accent: "#111111", "accent-2": "#494640" },
  });
}
