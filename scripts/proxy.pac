// Yubikiri hostname-mode PAC (static reference copy).
// The running agent also serves this dynamically at
// http://127.0.0.1:8899/proxy.pac (preferred; edit HOSTNAME_PROXY_HOSTS there).
// Only the listed hosts and their subdomains go to the local relay.
var YUBIKIRI_HOSTS = [
  "auctions.yahoo.co.jp", "www.yahoo.co.jp", "search.yahoo.co.jp", "yahoo.co.jp",
  "yimg.jp", "s.yimg.jp", "auction-assets.c.yimg.jp",
  "note.com", "assets.st-note.com", "poe.com",
  "www.google.com", "google.com", "www.google.co.jp"
];
var YUBIKIRI_PROXY = "PROXY 127.0.0.1:8899; SECURE 127.0.0.1:8899";
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  for (var i = 0; i < YUBIKIRI_HOSTS.length; i++) {
    var d = YUBIKIRI_HOSTS[i].toLowerCase();
    if (host === d || dnsDomainIs(host, "." + d)) return YUBIKIRI_PROXY;
  }
  return "DIRECT";
}
