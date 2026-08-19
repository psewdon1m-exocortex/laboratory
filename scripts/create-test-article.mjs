import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "../services/api/node_modules/fflate/esm/index.mjs";

const laboratoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(laboratoryRoot, "..");
const outputPath = path.join(projectRoot, "Laboratory Test Article.zip");

function createTestTone() {
  const sampleRate = 44_100;
  const durationSeconds = 2;
  const samples = sampleRate * durationSeconds;
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const fade = Math.min(1, index / 2205, (samples - index) / 2205);
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.18 * fade;
    wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return wav;
}

function createWorkflow(source) {
  const project = JSON.parse(source);
  project.metadata = {
    ...project.metadata,
    id: "project-laboratory-test-workflow",
    name: "Laboratory test workflow",
    description: "Read-only interactive canvas embedded in a Markdown article",
    updatedAt: "2026-08-18T00:00:00.000Z",
    tags: ["laboratory", "test"],
  };
  project.viewport = { x: 90, y: 55, zoom: 0.85 };
  project.nodes = [
    {
      id: "node-observation",
      kind: "node",
      nodeTypeId: "open-node.core.text",
      nodeTypeVersion: "1.0.0",
      position: { x: -260, y: -70 },
      size: { width: 250, height: 150 },
      label: "Observation",
      color: "#ca5f2b",
      bypassed: false,
      parameters: { value: "Collect source material" },
      ports: [{ id: "value", label: "Value", direction: "output", kind: "data", typeId: "core.string" }],
      parentContainerId: null,
      parentGroupId: null,
      uiState: { previewEnabled: true },
      runtimeHints: {},
    },
    {
      id: "node-publication",
      kind: "node",
      nodeTypeId: "open-node.output.display",
      nodeTypeVersion: "1.0.0",
      position: { x: 180, y: 95 },
      size: { width: 250, height: 150 },
      label: "Publication",
      color: "#4f8f88",
      bypassed: false,
      parameters: {},
      ports: [
        { id: "value", label: "Value", direction: "input", kind: "data", typeId: "core.any", required: true },
        { id: "result", label: "Result", direction: "output", kind: "data", typeId: "core.any" },
      ],
      parentContainerId: null,
      parentGroupId: null,
      uiState: { previewEnabled: true },
      runtimeHints: {},
    },
  ];
  project.connections = [{
    id: "connection-observation-publication",
    kind: "data",
    label: "revision",
    color: "#d7d3c8",
    source: { elementId: "node-observation", portId: "value" },
    target: { elementId: "node-publication", portId: "value" },
    thickness: 2,
    opacity: 0.85,
    dash: [],
    arrowhead: "end",
    routing: "bezier",
    routingOverride: false,
    reroutePoints: [],
  }];
  return Buffer.from(`${JSON.stringify(project, null, 2)}\n`);
}

async function downloadTestVideo() {
  const response = await fetch("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", {
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Test video download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error("Downloaded test video is not a supported MP4 file");
  }
  return bytes;
}

const article = `# A complete Laboratory article

This archive is intentionally published without an \`_id.txt\` file. Laboratory should assign its internal ID during the first import.

## Full-width image

::image{src="media/cover.png" alt="Abstract Laboratory cover" caption="A single image uses the full article width."}

## Gallery

The gallery resolves files by their unique basename, so the Markdown does not need storage IDs.

::gallery{src="gallery-one.png,gallery-two.png" alt="Gallery test" caption="Two responsive gallery images."}

## Audio

::audio{src="media/test-tone.wav" caption="A generated two-second 440 Hz test tone."}

## Video

::video{src="media/flower.mp4" poster="media/video-poster.png" caption="A CC0 sample video used to verify the inline player."}

## Downloadable file

::file{src="attachments/test-data.csv" label="Download the sample dataset"}

## Open Node canvas

The canvas loads near the viewport. The wheel pans or zooms the canvas while the pointer is inside it and scrolls the article outside it.

::workflow{src="media/test-workflow.onode.json" caption="A read-only interactive Laboratory workflow."}

## Remaining attachments

The PDF and text note are not referenced by directives, so Laboratory should append them automatically to the attachment list.
`;

const [cover, galleryOne, galleryTwo, referencePdf, workflowTemplate, video] = await Promise.all([
  fs.readFile(path.join(laboratoryRoot, "data", "defaults", "journal.png")),
  fs.readFile(path.join(laboratoryRoot, "data", "defaults", "hero.png")),
  fs.readFile(path.join(laboratoryRoot, "data", "defaults", "about.png")),
  fs.readFile(path.join(laboratoryRoot, "data", "defaults", "about-me.pdf")),
  fs.readFile(path.join(projectRoot, "kernel", "data", "defaults", "topology.onode.json"), "utf8"),
  downloadTestVideo(),
]);

const archive = zipSync({
  "article.md": strToU8(article),
  "media/cover.png": new Uint8Array(cover),
  "media/gallery-one.png": new Uint8Array(galleryOne),
  "media/gallery-two.png": new Uint8Array(galleryTwo),
  "media/video-poster.png": new Uint8Array(cover),
  "media/test-tone.wav": new Uint8Array(createTestTone()),
  "media/flower.mp4": new Uint8Array(video),
  "media/test-workflow.onode.json": new Uint8Array(createWorkflow(workflowTemplate)),
  "attachments/test-data.csv": strToU8("sample,value\nobservation,42\nrevision,2\n"),
  "attachments/read-me.txt": strToU8("This unreferenced file should appear in the generated attachment list.\n"),
  "attachments/reference.pdf": new Uint8Array(referencePdf),
}, { level: 6, mtime: new Date("2026-08-18T00:00:00.000Z") });

await fs.writeFile(outputPath, archive);
console.log(`${outputPath}\n${archive.length} bytes`);
