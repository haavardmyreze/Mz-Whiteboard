'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unfurl, readPage } = require('../unfurl');

test('unfurl: reads the Open Graph tags of a page, before its own title', () => {
  const html = `<!doctype html><html><head>
    <title>Own title</title>
    <meta property="og:title" content="Kilo &amp; the harbour">
    <meta name="description" content="Plain description">
    <meta content="Lit at dusk, &#8220;cold&#8221;." property="og:description" />
    <meta property='og:site_name' content='Vimeo'>
    <meta property="og:image" content="/pics/still.jpg?w=1200">
  </head><body><meta property="og:title" content="Not this"></body></html>`;
  assert.deepEqual(readPage(html, 'https://vimeo.com/123'), {
    title: 'Kilo & the harbour',
    desc: 'Lit at dusk, “cold”.',
    site: 'Vimeo',
    picture: 'https://vimeo.com/pics/still.jpg?w=1200',
  });
});

test('unfurl: falls back to the page title and description, and keeps them short', () => {
  const page = readPage(`<head><title>\n  A   page </title><meta name="description" content="${'x'.repeat(900)}"></head>`, 'http://a.test/');
  assert.equal(page.title, 'A page');
  assert.equal(page.desc.length, 500);
  assert.equal(page.picture, null);
  assert.equal(readPage('<head><meta property="og:image" content="javascript:alert(1)"></head>', 'http://a.test/').picture, null);
});

// A web stood in for: each address answers with what it is given.
function fakeWeb(pages) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const [status, type, body, extra = {}] = pages[url] || [404, 'text/plain', 'no'];
    return new Response(body, { status, headers: { 'content-type': type, ...extra } });
  };
  return { asked, fetchImpl };
}

test('unfurl: follows redirects, and fetches the picture', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const web = fakeWeb({
    'http://127.0.0.1/a': [301, 'text/html', '', { location: '/b' }],
    'http://127.0.0.1/b': [200, 'text/html; charset=utf-8', '<head><meta property="og:title" content="B"><meta property="og:image" content="pic.png"></head>'],
    'http://127.0.0.1/pic.png': [200, 'image/png', png],
  });
  const page = await unfurl('http://127.0.0.1/a', { fetchImpl: web.fetchImpl });
  assert.equal(page.url, 'http://127.0.0.1/b');
  assert.equal(page.title, 'B');
  assert.deepEqual(page.picture, { bytes: png, ext: '.png' });
});

test('unfurl: a page whose picture is missing is still read; a page that is a picture is its own', async () => {
  const web = fakeWeb({
    'http://127.0.0.1/a': [200, 'text/html', '<title>A</title><meta property="og:image" content="/gone.png">'],
    'http://127.0.0.1/still.jpg': [200, 'image/jpeg', 'jpeg'],
  });
  const page = await unfurl('http://127.0.0.1/a', { fetchImpl: web.fetchImpl });
  assert.equal(page.title, 'A');
  assert.equal(page.picture, null);
  const pic = await unfurl('http://127.0.0.1/still.jpg', { fetchImpl: web.fetchImpl });
  assert.equal(pic.title, 'still.jpg');
  assert.equal(pic.picture.ext, '.jpg');
});

test('unfurl: never reads a link-local address, even when sent there', async () => {
  const web = fakeWeb({ 'http://127.0.0.1/a': [302, 'text/html', '', { location: 'http://169.254.169.254/latest' }] });
  await assert.rejects(unfurl('http://169.254.169.254/latest', { fetchImpl: web.fetchImpl }), (err) => err.status === 400);
  await assert.rejects(unfurl('http://127.0.0.1/a', { fetchImpl: web.fetchImpl }), (err) => err.status === 400);
  assert.deepEqual(web.asked, ['http://127.0.0.1/a']);
});
