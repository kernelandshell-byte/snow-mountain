(async () => {
  const report = (obj) => console.log('SPIKE_RESULT ' + JSON.stringify(obj));

  const base = {
    href: location.href,
    contentType: document.contentType,
    readyState: document.readyState,
  };

  // Does the page even look like the native PDF viewer, or a blocked/empty doc?
  try {
    base.title = document.title;
    base.bodyChildCount = document.body ? document.body.children.length : null;
    base.hasEmbed = !!document.querySelector('embed');
  } catch (e) {
    base.domError = String(e);
  }

  // Can we get the PDF's own bytes back out, same-origin, no cross-site fetch?
  try {
    const res = await fetch(location.href);
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 5));
    base.fetchOk = true;
    base.fetchByteLength = buf.byteLength;
    base.fetchMagic = String.fromCharCode(...head);
  } catch (e) {
    base.fetchOk = false;
    base.fetchError = String(e);
  }

  report(base);
})();
