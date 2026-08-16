// A wildcard listener is reachable locally, but its unspecified address is not
// a useful browser destination. Concrete bind addresses should be opened as-is.
export function serveUrl(host, port) {
  const address = !host || host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const authority = address.includes(":") ? `[${address}]` : address;
  return `http://${authority}:${port}`;
}
