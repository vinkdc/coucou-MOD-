// A workspace preset: what the island offers for one kind of work. Developer
// is the first; designer and business presets fill the same slots later.

export type ToolId = "ports" | "scripts";

export interface Preset {
  id: string;
  label: string;
  /** The cards of the Tools tab, left to right. */
  tools: ToolId[];
}
