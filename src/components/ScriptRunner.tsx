"use client";

import { useEffect } from "react";

/**
 * Re-runs a mockup screen's original inline <script> after React has injected
 * the screen markup, because those scripts were written for a plain browser
 * page load (they register DOMContentLoaded/load handlers and define globals
 * used by inline onclick attributes).
 */
export default function ScriptRunner({ code }: { code: string }) {
  useEffect(() => {
    if (!code || !code.trim()) return;

    try {
      // Indirect eval → runs in global scope, so `function switchTab(){}` etc.
      // become window globals reachable by inline onclick="..." attributes.
      (0, eval)(code);
    } catch (e) {
      console.warn("[ScriptRunner] script error:", e);
      return;
    }

    // The script usually wrapped itself in a DOMContentLoaded/load listener,
    // which will never fire now (the document is long past loading), so fire
    // the readiness events ourselves to invoke those handlers.
    try {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    } catch (e) {
      console.warn("[ScriptRunner] DOMContentLoaded:", e);
    }
    try {
      window.dispatchEvent(new Event("load"));
    } catch (e) {
      console.warn("[ScriptRunner] load:", e);
    }
  }, [code]);

  return null;
}
