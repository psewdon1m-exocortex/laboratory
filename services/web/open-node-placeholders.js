export function placeholderNodeDefinitions(project) {
  const nodes = project && typeof project === "object" && Array.isArray(project.nodes)
    ? project.nodes
    : [];
  const definitions = new Map();
  for (const node of nodes) {
    const typeId = String(node.nodeTypeId || "");
    const version = String(node.nodeTypeVersion || "1.0.0");
    if (!typeId || typeId.startsWith("open-node.")) continue;
    const key = `${typeId}@${version}`;
    if (definitions.has(key)) continue;
    const ports = Array.isArray(node.ports) ? node.ports : [];
    const portDefinition = ({ direction: _direction, dynamic: _dynamic, ...port }) => port;
    const parameters = node.parameters && typeof node.parameters === "object"
      ? structuredClone(node.parameters)
      : {};
    definitions.set(key, {
      typeId,
      version,
      displayName: String(node.label || typeId.split(".").at(-1) || "Node"),
      description: "Decorative definition supplied by Laboratory for a read-only canvas.",
      category: "Embedded",
      defaultColor: typeof node.color === "string" ? node.color : "#6f746f",
      inputs: ports.filter((port) => port.direction === "input").map(portDefinition),
      outputs: ports.filter((port) => port.direction === "output").map(portDefinition),
      parameters: [],
      pure: true,
      createDefaultParams: () => structuredClone(parameters),
      validate: () => ({ valid: true, issues: [] }),
      execute: async () => ({ outputs: {} }),
    });
  }
  return [...definitions.values()];
}
