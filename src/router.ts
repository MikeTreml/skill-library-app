// Cycle-free indirection between views and the app shell. Views must not import
// main.ts directly (main imports every view — that would be circular). Instead
// main.ts registers its shell functions here at bootstrap, and views call
// through this registry. This module imports nothing, so it can never cycle.
import type { View } from "./state";

export const router = {
  /** Re-render the active view (registered by main.ts). */
  renderMain: (() => {}) as () => void,
  /** Switch to a view and re-render (registered by main.ts). */
  goToView: ((_v: View) => {}) as (v: View) => void,
  /** Reload all state from the backend, then re-render (registered by main.ts). */
  load: (async () => {}) as () => Promise<void>,
  /** Open the settings panel (registered by main.ts). */
  openSettings: (async () => {}) as () => Promise<void>,
};
