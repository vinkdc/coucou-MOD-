// The registry of presets, and the one the user works with (Settings.role).

import { State } from "../core/state";
import { developer } from "./developer";
import type { Preset } from "./types";

export type { Preset, ToolId } from "./types";

const PRESETS: Preset[] = [developer];

export function currentPreset(): Preset {
  return PRESETS.find((p) => p.id === State.settings.role) ?? developer;
}
