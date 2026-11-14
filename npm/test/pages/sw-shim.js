// The one file a site adds to get the full UI with the package on a CDN.
// Normally the URL is written out; the tests pass it in.
importScripts(new URL(self.location.href).searchParams.get("cdn") + "sw.js");
