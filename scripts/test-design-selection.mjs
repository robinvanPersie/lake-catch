import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const script = readFileSync(new URL('../apps/desktop/src-tauri/src/design-selection.js', import.meta.url), 'utf8');
const href = 'https://lanhuapp.com/web/#/item/project/detailDetach?pid=project&image_id=parent&type=set';
function selection(image, versionIndex = 0, url = href, routeImage = 'parent') {
  return runInNewContext(script, {
    URL, URLSearchParams,
    document: { title: 'parent title' },
    window: { location: { href: url }, detailDetach: {
      initDone: true, image, versionIndex,
      $route: { query: { pid: 'project', image_id: routeImage } }
    } }
  });
}
const image = (id, name) => ({ id, name, versions: [{ id: `${id}-latest` }, { id: `${id}-older` }] });

test('three group tabs resolve different images despite identical location and duplicate names', () => {
  for (const [id, name] of [['parent', 'main'], ['child-a', 'salary'], ['child-b', 'salary']]) {
    const selected = selection(image(id, name));
    const params = new URLSearchParams(new URL(selected.url).hash.split('?')[1]);
    assert.equal(params.get('image_id'), 'parent');
    assert.equal(params.get('child') || params.get('image_id'), id);
    assert.equal(params.get('version_id'), `${id}-latest`);
    assert.equal(params.get('pid'), 'project');
    assert.equal(selected.title, name);
  }
});
test('current historical version is preserved and child index aliases are removed', () => {
  const selected = selection(image('child-b', 'salary'), 1, href + '&childImg=0&child=child-a&child_img=1&docId=parent');
  const params = new URLSearchParams(new URL(selected.url).hash.split('?')[1]);
  assert.equal(params.get('image_id'), 'parent');
  assert.equal(params.get('child'), 'child-b');
  assert.equal(params.get('version_id'), 'child-b-older');
  for (const key of ['childImg', 'child_img', 'docId']) assert.equal(params.has(key), false);
});
test('unready, stale, or missing version state fails instead of syncing the parent', () => {
  assert.throws(() => selection(null));
  assert.throws(() => selection(image('child-a', 'salary'), 0, href, 'previous-route'));
  assert.throws(() => selection(image('child-a', 'salary'), 9));
});
test('non-detail pages keep their original URL', () => {
  const selected = selection(null, 0, 'https://lanhuapp.com/web/#/item');
  assert.equal(selected.url, 'https://lanhuapp.com/web/#/item');
});
