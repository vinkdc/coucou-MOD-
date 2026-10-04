// The guide's "Show me": a click-through window over the main display that
// draws one pulsing ring around the thing to click. Rust sizes and shows the
// window and sends the rectangle (logical px); this page only draws it.

import { listen } from "@tauri-apps/api/event";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;
const ring = document.getElementById("ring") as HTMLElement;

const css = document.createElement("style");
css.textContent = `
  html, body { background: transparent; }
  #ring {
    position: fixed;
    display: none;
    border-radius: 12px;
    border: 3px solid #ffb340;
    box-shadow: 0 0 0 2px rgba(11, 12, 14, 0.55), 0 0 22px 4px rgba(255, 179, 64, 0.65);
    pointer-events: none;
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.06); opacity: 0.7; }
  }
`;
document.head.append(css);

void listen<Box>("highlight", (e) => {
  const b = e.payload;
  ring.style.left = `${b.x - PAD}px`;
  ring.style.top = `${b.y - PAD}px`;
  ring.style.width = `${b.w + PAD * 2}px`;
  ring.style.height = `${b.h + PAD * 2}px`;
  ring.style.display = "block";
});

void listen("highlight-clear", () => {
  ring.style.display = "none";
});
