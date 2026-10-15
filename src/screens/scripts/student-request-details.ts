// AUTO-GENERATED from screens-src — do not edit by hand.
const code: string = "\n  // Close dropdown on outside click\n  window.addEventListener('click', function(e) {\n    const btn = document.getElementById('actionsDropdownBtn');\n    const menu = document.getElementById('actionsMenu');\n    if (btn && menu && !btn.contains(e.target) && !menu.contains(e.target)) {\n      menu.classList.add('hidden');\n    }\n  });\n\n;\n";
export default code;
