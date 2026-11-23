(() => {
  const page = new URL(window.location.href);
  const queryStart = page.hash.indexOf('?');
  const params = new URLSearchParams(queryStart >= 0 ? page.hash.slice(queryStart + 1) : page.search);
  const detail = window.detailDetach;
  let title = document.title;
  if (page.hash.includes('/detailDetach')) {
    // The group switcher changes detail.image without navigating. Capture the
    // image and version together, rather than inferring selection from the URL.
    if (!detail || !detail.initDone || !detail.image?.id ||
        detail.$route?.query?.image_id !== params.get('image_id') ||
        String(detail.$route?.query?.pid || '') !== String(params.get('pid') || '')) {
      throw new Error('设计稿尚未加载完成，请等待当前标签显示后重新同步');
    }
    const image = detail.image;
    const version = image.versions?.[detail.versionIndex ?? 0];
    if (!version?.id) throw new Error('尚未读取到当前设计稿版本，请稍后重新同步');
    // Keep the parent route so reopening a saved selection retains the group tabs.
    for (const key of ['child', 'childImg', 'child_img', 'docId']) params.delete(key);
    if (image.id !== params.get('image_id')) params.set('child', image.id);
    params.set('version_id', version.id);
    page.hash = page.hash.slice(0, queryStart) + '?' + params.toString();
    title = image.name || title;
  }
  return { url: page.href, title };
})()
