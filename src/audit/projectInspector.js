import path from 'node:path';

/**
 * ProjectInspector
 * Deeply inspects an existing project workspace before any code changes are made.
 * Identifies existing routes, framework, package scripts, existing entry points,
 * and ensures requested features are implemented without destructive overwrites.
 */
export class ProjectInspector {
  /**
   * Inspect project workspace
   * @param {import('../sandbox/sandboxExecutor.js').SandboxExecutor} sandbox
   * @param {string} projectId
   * @returns {Object} Project map and convention summary
   */
  static inspect(sandbox, projectId) {
    const files = sandbox.listFiles(projectId);

    let pkg = null;
    try {
      const pkgContent = sandbox.readFileSafely(projectId, 'package.json');
      pkg = JSON.parse(pkgContent);
    } catch (_) {}

    const hasPublicIndex = files.includes('public/index.html');
    const hasRootIndex = files.includes('index.html');
    const entryHtmlPath = hasPublicIndex ? 'public/index.html' : hasRootIndex ? 'index.html' : null;

    let existingHtml = '';
    let existingRoutes = ['/'];
    let existingFeatures = [];

    if (entryHtmlPath) {
      try {
        existingHtml = sandbox.readFileSafely(projectId, entryHtmlPath);
        // Detect existing routes / subviews
        const routeMatches = existingHtml.match(/data-route=["']([^"']+)["']/g) || [];
        routeMatches.forEach(m => {
          const r = m.replace(/data-route=["']/, '').replace(/["']/, '');
          if (!existingRoutes.includes(r)) existingRoutes.push(r);
        });

        // Detect existing feature indicators
        if (/id=["']view-store["']|product-grid|cart-drawer/i.test(existingHtml)) {
          existingFeatures.push('ECOMMERCE_STOREFRONT');
        }
        if (/id=["']form-login["']|id=["']view-auth["']|login-form/i.test(existingHtml)) {
          existingFeatures.push('USER_AUTHENTICATION');
        }
        if (/chat-container|message-feed|id=["']view-chat["']/i.test(existingHtml)) {
          existingFeatures.push('REALTIME_CHAT');
        }
      } catch (_) {}
    }

    const hasBackendApi = files.includes('src/api.js') || files.includes('src/server.js') || files.includes('server.js');
    const hasTests = files.some(f => f.startsWith('tests/') || f.includes('.test.js') || f.includes('.spec.js'));

    const framework = pkg?.dependencies?.react ? 'React' :
                      pkg?.dependencies?.vue ? 'Vue' :
                      pkg?.dependencies?.express ? 'Express' :
                      entryHtmlPath ? 'Vanilla HTML5/JS' : 'Node.js Service';

    return {
      projectId,
      filesCount: files.length,
      files,
      pkg,
      framework,
      entryHtmlPath,
      hasIndexHtml: Boolean(entryHtmlPath),
      hasBackendApi,
      hasTests,
      existingRoutes,
      existingFeatures,
      hasRunnableServer: files.includes('src/server.js') || files.includes('server.js'),
      preservedFiles: files.filter(f => !['public/index.html', 'src/api.js', 'tests/api.test.js'].includes(f))
    };
  }
}
