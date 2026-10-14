'use strict';
// Read in the head of every page, before anything is drawn: the theme and the density this browser
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
  // Compact rows on a phone, unless this browser chose cards.
  const density = read('wb:density');
  if (density === 'compact' || (density == null && matchMedia('(max-width: 560px)').matches)) root.dataset.density = 'compact';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = root.dataset.theme === 'light' ? '#f0f0f0' : '#090909';
})();
