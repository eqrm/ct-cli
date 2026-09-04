const SCALAR_VERSION = "1.67.0";

export function renderScalarDocs(nonce: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ct-cli Extension API</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}"></script>
    <script nonce="${nonce}">
      Scalar.createApiReference('#app', {
        url: '/api/v1/openapi.json',
        pageTitle: 'ct-cli Extension API',
        hideClientButton: true,
        hideDownloadButton: false,
        showSidebar: true,
        showDeveloperTools: 'never',
        withDefaultFonts: false,
        telemetry: false,
        agent: {
          disabled: true,
        },
      })
    </script>
  </body>
</html>
`;
}
