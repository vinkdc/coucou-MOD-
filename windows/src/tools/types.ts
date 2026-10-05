// A card on the Tools tab. The view calls `refresh` while it is on screen and
// never otherwise, so a tool costs nothing while the tab is closed.

export interface ToolCard {
  el: HTMLElement;
  refresh(): void;
}
