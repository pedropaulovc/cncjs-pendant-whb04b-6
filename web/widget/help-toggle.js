// Toggletip for an in-flow help panel: hovering or focusing the button
// previews it, clicking pins it open, and a second click or Escape closes it.
// The panel stays in normal page flow, so it never overflows a narrow widget.
const HOVER_GRACE = 250;

export function wireHelpToggle(button, panel, { schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
  const state = { pinned: false, hovered: false, focused: false, dismissed: false };
  let timer = null;
  const render = () => {
    const open = !state.dismissed && (state.pinned || state.hovered || state.focused);
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  const set = changes => { Object.assign(state, changes); render(); };
  const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  // A short grace period lets the pointer travel from the button to the panel.
  const enter = () => { stopTimer(); set({ hovered: true, dismissed: false }); };
  const leave = () => { stopTimer(); timer = schedule(() => { timer = null; set({ hovered: false }); }, HOVER_GRACE); };
  for (const target of [button, panel]) {
    target.addEventListener('mouseenter', enter);
    target.addEventListener('mouseleave', leave);
  }
  button.addEventListener('focus', () => set({ focused: true, dismissed: false }));
  button.addEventListener('blur', () => set({ focused: false }));
  button.addEventListener('click', () => set(state.pinned && !panel.hidden ? { pinned: false, dismissed: true } : { pinned: true, dismissed: false }));
  button.ownerDocument.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) set({ pinned: false, dismissed: true });
  });
  render();
}
