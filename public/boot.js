'use strict';
// Read in the head of every page, before anything is drawn: the theme and the layout this browser
// chose, so a page never flashes the other one first. The bar colour of a phone's browser follows the
// theme's background (style.css --bg).
(() => {
  const read = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  };
  const root = document.documentElement;
  root.dataset.theme = read('wb:theme') === 'light' ? 'light' : 'dark';
  // Lists as cards, compact rows or a table (common.js, layout); compact rows on a phone unless this
  // browser chose otherwise.
  const layout = read('wb:layout');
  root.dataset.layout = ['cards', 'rows', 'table'].includes(layout) ? layout : matchMedia('(max-width: 560px)').matches ? 'rows' : 'cards';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = root.dataset.theme === 'light' ? '#f0f0f0' : '#101010';
})();
